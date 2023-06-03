import { AnyRouter } from "@trpc/server";
import { FetchHandlerRequestOptions } from "@trpc/server/adapters/fetch";
import { HTTPRequest } from "@trpc/server/http";
import { ResponseMetaFn, resolveSSEResponse } from "./resolveSSEResponse";

export type SSEHandlerRequestOptions<TRouter extends AnyRouter> = Omit<
  FetchHandlerRequestOptions<TRouter>,
  "responseMeta"
  > & {
    responseMeta?: ResponseMetaFn<TRouter>;
  }

export  async function sseRequestHandler<TRouter extends AnyRouter>(
  opts: SSEHandlerRequestOptions<TRouter>,
): Promise<Response> {
  const {
    endpoint,
    router,
//TODO: batching,
    onError,
    responseMeta,
    req,
    createContext,
  } = opts;

  const resHeaders = new Headers();

  const { pathname, searchParams } = new URL(req.url);
  const path = pathname.slice(endpoint.length + 1);
  const isBodyJSON = req.headers.get("Content-Type") === "application/json";
  console.log("BODY IS JSON: ", isBodyJSON);
  const httpRequest: HTTPRequest = {
    query: searchParams,
    method: req.method,
    headers: Object.fromEntries(req.headers),
    body: isBodyJSON ? await req.text() : "",
  };
  console.log("Handler received request: ", JSON.stringify(httpRequest, null, 2))

  const result = await resolveSSEResponse({
    req: httpRequest,
    path,
    router,
    // only set if we have a value
//TODO:    ...(batching && { batching }),
    ...(responseMeta && { responseMeta }),
    createContext: async () => createContext?.({ req, resHeaders }),
    onError: (o) => void onError?.({ ...o, req }),
  })

  for (const [key, value] of Object.entries(result.headers ?? {})) {
    /* istanbul ignore if -- @preserve */
    if (typeof value === "string") resHeaders.set(key, value);
    if (Array.isArray(value)) value.forEach((v) => resHeaders.append(key, v));
  }
  
  return new Response(result.body, {
    status: result.status,
    headers: resHeaders,
  });
}

