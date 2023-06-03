import type { HTTPHeaders } from "@trpc/client";
import {
  AnyProcedure,
  ProcedureRouterRecord,
  TRPCError,
  getTRPCErrorFromUnknown,
  inferRouterContext,
  inferRouterError,
  type AnyRouter,
  type CombinedDataTransformer,
  type Maybe,
  type MaybePromise,
  type ProcedureType,
} from "@trpc/server";
import {
  getHTTPStatusCode,
  ResponseMeta,
  type HTTPRequest,
} from "@trpc/server/http";
import { isObservable } from "@trpc/server/observable";
import {
  TRPCResponse,
  TRPCResponseMessage,
  TRPC_ERROR_CODES_BY_KEY,
} from "@trpc/server/rpc";
import { getErrorShape, transformTRPCResponse } from "@trpc/server/shared";
import { toss } from "./toss";
import { BaseHandlerOptions } from "@trpc/server/dist/internals/types";

const HTTP_METHOD_PROCEDURE_TYPE_MAP: Record<
  string,
  ProcedureType | undefined
> = {
  GET: "query",
  PATCH: "subscription",
  POST: "mutation",
};

const fallbackContentTypeHandler = {
  getInputs: getJsonContentTypeInputs,
};

export async function resolveSSEResponse<
  TRouter extends AnyRouter,
>(opts: ResolveSSERequestOptions<TRouter, HTTPRequest>): Promise<HTTPResponse> {
  const {
    router,
    req,
    createContext,
    onError,
    path,
    responseMeta,
    error,
    preprocessedBody = false,
//TODO: batching: _batching,
    contentTypeHandler = fallbackContentTypeHandler,
  } = opts;

  // can be used for lambda warmup
  if (req.method === "HEAD") return { status: 204 };

  const method = req.method;
  const type = HTTP_METHOD_PROCEDURE_TYPE_MAP[method] ?? "unknown";
  let ctx: inferRouterContext<TRouter> | undefined = undefined;

//TODO: Const isBatchCall = !!req.query.get("batch");
  const paths: string[] = /* isBatchCall ? path.split(",") : */ [path];

  const getInputs = contentTypeHandler.getInputs.bind(contentTypeHandler, {
//TODO: isBatchCall,
    req,
    router,
    preprocessedBody,
  });
  
  type TRouterError = inferRouterError<TRouter>;
  type TRouterResponse = TRPCResponse<unknown, TRouterError>;

  // TODO: support batching? Is it possible to combine this with https://trpc.io/docs/links/httpBatchStreamLink ?

  try {
    if (error) throw error;
//TODO: if (isBatchCall) toss(`Batching SSE requests is not supported`, -32022);
    if (type !== "subscription") toss(`Unexpected method: ${method}`, -32005);

    ctx = await createContext();

    const inputs = await getInputs();

    const rawResults = await Promise.all(
      paths.map(async (path, index) => {
        const input = inputs[index];

        try {
          const output = await callProcedure({
            procedures: router._def.procedures,
            path,
            rawInput: input,
            ctx,
            type,
          });
          return {
            input,
            path,
            data: output,
          };
        } catch (cause) {
          const error = getTRPCErrorFromUnknown(cause);

          onError?.({ error, path, input, ctx, type, req });
          return {
            input,
            path,
            error,
          };
        }
      }),
    );

    const errors = rawResults.flatMap((obj) => (obj.error ? [obj.error] : []));
    const resultEnvelopes = rawResults.map(
      ({ input, path, error, data }): TRouterResponse => {
        if (!error) return { result: { data } };
        return {
          error: getErrorShape({
            config: router._def._config,
            error,
            type,
            path,
            input,
            ctx,
          }),
        };
      },
    );

    const result = /*TODO: isBatchCall ? resultEnvelopes :  */resultEnvelopes[0]!;

    return endResponse(result, errors);
  } catch (cause) {
    // we get here if
    // - batching is called when it's not enabled
    // - `createContext()` throws
    // - post body is too large
    // - input deserialization fails
    // - `errorFormatter` return value is malformed
    const error = getTRPCErrorFromUnknown(cause);

    onError?.({
      error,
      path: undefined,
      input: undefined,
      ctx,
      type,
      req,
    });
    return endResponse(
      {
        error: getErrorShape({
          config: router._def._config,
          error,
          type,
          path: undefined,
          input: undefined,
          ctx,
        }),
      },
      [error],
    );
  }

  function endResponse(
    untransformedJSON: TRouterResponse | TRouterResponse[],
    errors: TRPCError[],
  ): HTTPResponse {
    let status = getHTTPStatusCode(untransformedJSON);

    const headers: HTTPHeaders = {};

    const meta =
      responseMeta?.({
        ...(paths && { paths }), // only set if we have paths
        ctx,
        type,
        data: Array.isArray(untransformedJSON)
          ? untransformedJSON
          : [untransformedJSON],
        errors,
      }) ?? {};

    status = meta?.status ?? status;

    for (const [key, value] of Object.entries(meta.headers ?? {})) {
      headers[key] = value;
    }

    if (type === "subscription") {
      untransformedJSON = [untransformedJSON].flat()[0]!; // assert there is only one result and unwrap it
      
      if ("error" in untransformedJSON) {
        console.error("ERROR IN SUBSCRIPTION: ", JSON.stringify(untransformedJSON, null, 2));
        return {
          body: JSON.stringify(untransformedJSON),
          status,
          headers: {
            ...headers,
            "Content-Type": "text/event-stream",
            Connection: "keep-alive",
            // see https://github.com/vercel/next.js/issues/9965#issuecomment-587355489
            "Cache-Control": "no-cache, no-transform",
            // avoid buffering by reverse proxies (e.g. nginx)
            "X-Accel-Buffering": "no",
          },
        };
      }

      const observable = untransformedJSON.result.data;

      const rpcMeta = {
        id: `${untransformedJSON.id}`,
        jsonrpc: "2.0" as const,
      };

      if (!isObservable(observable)) {
        toss(`Subscription ${path} did not return an observable`, -32603);
      }

      let count = 0;
      const encoder = new TextEncoder();

      /**
       * 
       * @param controller 
       * @param input "START" | "STOP" sends a "started" | "stopped" event. Any other input is sent as data
       */
      function sendEvent(
        controller: ReadableStreamDefaultController<Uint8Array>,
        input: unknown,
      ): void {
        let result;
        switch (input) {
          case "START":
            result = { type: "started" as const };
            break;
          case "STOP":
            result = { type: "stopped" as const };
            break;
          default:
            result = { data: input, type: "data" as const };
            break;
        }

        const envelope: TRPCResponseMessage = { result, ...rpcMeta };
        const json = transformTRPCResponse(router._def._config, envelope);

        const eventId = `id:${rpcMeta.id}/${count++}`;
        const eventData = `data:${JSON.stringify(json)}`;
        const event = `${eventData}\n${eventId}\n\n`;
        
        const bytes = encoder.encode(event);
        controller.enqueue(bytes);
      }

      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          const subscription = observable.subscribe({
            next: (data) => {
              console.log(data)
              if (count === 0) sendEvent(controller, "START");
              sendEvent(controller, data);
            },
            complete: () => {
              sendEvent(controller, "STOP");
              controller.close();
            },
            error: async (err) => {
              const {
                code: status_code,
                message,
                name,
              } = getTRPCErrorFromUnknown(err);
              const input = (await getInputs())[paths.indexOf(path)];
              const data = { path, input, type, error: name };
              const code = TRPC_ERROR_CODES_BY_KEY[status_code];
              const envelope = { error: { code, message, data }, ...rpcMeta };
              const json = transformTRPCResponse(router._def._config, envelope);
              //TODO: test this by throwing error from procedure
              controller.error(json);
            },
          });

          return () => {
            subscription.unsubscribe();
          };
        },
      });

      return {
        body,
        status,
        headers,
      };
    }

    const transformedJSON = transformTRPCResponse(
      router._def._config,
      untransformedJSON,
    );

    const body = JSON.stringify(transformedJSON);

    return {
      body,
      status,
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
    };
  }
}

function getRawProcedureInputOrThrow(opts: {
  req: HTTPRequest;
  preprocessedBody: boolean;
}) {
  const { req, preprocessedBody } = opts;
  try {
    if (req.method === "GET") {
      if (!req.query.has("input")) {
        return undefined;
      }
      const raw = req.query.get("input");
      return JSON.parse(raw!);
    }
    if (!preprocessedBody && typeof req.body === "string") {
      // A mutation with no inputs will have req.body === ''
      return req.body.length === 0 ? undefined : JSON.parse(req.body);
    }
    return req.body;
  } catch (err) {
    throw new TRPCError({
      code: "PARSE_ERROR",
      cause: err instanceof Error ? err : undefined,
    });
  }
}

function deserializeInputValue(
  rawValue: unknown,
  transformer: CombinedDataTransformer,
) {
  return typeof rawValue === "undefined"
    ? undefined
    : transformer.input.deserialize(rawValue);
}

function getJsonContentTypeInputs(
  opts: Parameters<GetInputs>[0],
): ReturnType<GetInputs> {
  const rawInput = getRawProcedureInputOrThrow(opts);
  console.log("GOT RAW INPUT: ", JSON.stringify(rawInput, null, 2));
  const transformer = opts.router._def._config.transformer;

//TODO:if (!opts.isBatchCall) {
    return {
      0: deserializeInputValue(rawInput, transformer),
    };
/*TODO:   }

  assertValidBatchInput(rawInput);

  const input: typeof rawInput = {};
  for (const key in rawInput) {
    const k = key as `${number}`;
    input[k] = deserializeInputValue(rawInput[k], transformer);
  }

  return input;
  */
}

function callProcedure(opts: {
  ctx: unknown;
  rawInput: unknown;
  input?: unknown;
  path: string;
  type: ProcedureType;
  procedures: ProcedureRouterRecord;
}) {
  const { type, path, procedures } = opts;

  if (!(path in procedures) || !procedures[path]?._def[type]) {
    toss(`No "${type}"-procedure on path "${path}"`, -32004);
  }

  const procedure = procedures[path] as AnyProcedure;
  return procedure(opts);
}

interface ResolveSSERequestOptions<
  TRouter extends AnyRouter,
  TRequest extends HTTPRequest,
> extends BaseHandlerOptions<TRouter, TRequest> {
  createContext: () => Promise<inferRouterContext<TRouter>>;
  req: TRequest;
  path: string;
  error?: Maybe<TRPCError>;
  contentTypeHandler?: BaseContentTypeHandler<any>;
  preprocessedBody?: boolean;
  responseMeta?: ResponseMetaFn<TRouter>;
}

interface HTTPResponse {
  status: number;
  headers?: HTTPHeaders;
  body?: string | ReadableStream<Uint8Array>;
}

type GetInputs = (opts: {
  req: HTTPRequest;
//TODO:  isBatchCall: boolean;
  router: AnyRouter;
  preprocessedBody: boolean;
}) => MaybePromise<Record<number, unknown>>;

type BodyResult =
  | {
      ok: true;
      data: unknown;
      /**
       * If the HTTP handler has already parsed the body
       */
      preprocessed: boolean;
    }
  | { ok: false; error: TRPCError };

type BaseContentTypeHandler<TOptions> = {
  isMatch(opts: TOptions): boolean;
  getBody: (opts: TOptions) => MaybePromise<BodyResult>;
  getInputs: GetInputs;
};

export type ResponseMetaFn<TRouter extends AnyRouter> = (opts: {
  data: TRPCResponse<unknown, inferRouterError<TRouter>>[];
  ctx?: inferRouterContext<TRouter>;
  /**
   * The different tRPC paths requested
   **/
  paths?: string[];
  type: ProcedureType | 'unknown';
  errors: TRPCError[];
}) => ResponseMeta;

/*
//TODO
function assertValidBatchInput(
  x: unknown,
): asserts x is Record<`${number}`, unknown> {
  if (typeof x === "object" && x && !Array.isArray(x)) return;
  toss('"input" must be an object when doing a batch call', -32600);
} */
