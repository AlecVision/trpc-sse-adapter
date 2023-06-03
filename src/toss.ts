import { TRPCError } from "@trpc/server";
import { TRPC_ERROR_CODE_KEY, TRPC_ERROR_CODE_NUMBER, TRPC_ERROR_CODES_BY_NUMBER } from "@trpc/server/rpc";

/**
 * Like throwing, but shorter.
 * @param message - error message
 * @param code - TRPC error code (you can lookup numeric codes with `TRPC_ERROR_CODES_BY_NUMBER[`(error code)`]`)
 * @param cause - optional cause (usually this will be the argument passed to `catch`)
 * @throws {TRPCError}
 * @see TRPC_ERROR_CODES_BY_NUMBER:
 * - "-32700": "PARSE_ERROR";
 * - "-32600": "BAD_REQUEST";
 * - "-32603": "INTERNAL_SERVER_ERROR";
 * - "-32001": "UNAUTHORIZED";
 * - "-32003": "FORBIDDEN";
 * - "-32004": "NOT_FOUND";
 * - "-32005": "METHOD_NOT_SUPPORTED";
 * - "-32008": "TIMEOUT";
 * - "-32009": "CONFLICT";
 * - "-32012": "PRECONDITION_FAILED";
 * - "-32013": "PAYLOAD_TOO_LARGE";
 * - "-32022": "UNPROCESSABLE_CONTENT";
 * - "-32029": "TOO_MANY_REQUESTS";
 * - "-32099": "CLIENT_CLOSED_REQUEST
 */
export function toss(
    message: string,
    code: TRPC_ERROR_CODE_KEY | TRPC_ERROR_CODE_NUMBER,
    cause?: unknown,
  ): never {
    if (typeof code === "number") code = TRPC_ERROR_CODES_BY_NUMBER[code];
    const err = new TRPCError({
      code,
      message,
      cause,
    });
    console.error(err);
    throw err;
  }
