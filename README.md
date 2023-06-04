# tRPC Fetch-SSE Adapter

Because tRPC transmits data as JSON, sending (and subscribing to) individual Server-Sent event streams is not possible by default (which is handy if, say, you want to use SSE to send chunks of a ChatGPT response as they are generated). This adapter enables that functionality.

</br>

## Table of Contents

- [Usage](#usage)
  - [Adding the Adapter](#adding-the-adapter)
  - [Creating SSE Stream Procedures](#creating-sse-stream-procedures)
- [License](#license)
- [Author](#author)

</br>

## Usage

> See [the `trpc-sse-link` package](https://github.com/alecvision/trpc-sse-link) for the client-side link needed to consume SSE streams.

First, install the adapter:

```bash
npm install @alecvision/trpc-sse-adapter
```

There are two steps to implementing this adapter:

1. Add the adapter to your server and tell it which procedures are SSE streams
2. Create `subscription` procedures for your SSE streams

</br>

### Adding the Adapter

---

This adapter ONLY handles requests for SSE streams. Batching of SSE Stream requests is not supported. Creating an SSE stream is as simple as creating a subscription procedure, just as you would with WebSockets - but tRPC doesn't know the difference between a WebSocket and an SSE stream. You must tell it which procedures are SSE streams and handle them accordingly. For example, using Next.js:

```ts
import type { NextRequest } from "next/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { sseRequestHandler } from "@alecvision/trpc-sse-adapter";
import { appRouter, createTRPCContext } from "../../../server";

const SSE_PROCEDURE_PATTERNS = [
  /ticker\.start$/,
  /chatgpt\.generate$/,
  /*
    prefixes/suffixes are an easy way to arbitrarily define SSE streams by giving
    them a special name (e.g. `myProcedure.stream_getSomeStreamingData`)
    */
  /^.*\.stream_\w+$/
];

// This MUST return the same value as is returned by the equivalent client-side function
function isStreamable(path: string) {
  return SSE_PROCEDURE_PATTERNS.some(regex => regex.test(path));
}

// Vercel only supports SSE on the edge runtime (WebSockets are not supported at all)
export const config = {
  runtime: "edge"
};

export default async function handler(req: NextRequest) {
  if (isStreamable(req.nextUrl.pathname)) {
    // Accepts a subset of the options for the fetch adapter
    return sseRequestHandler({
      endpoint: "/api/trpc",
      router: appRouter,
      req,
      createContext: createTRPCContext
    });
  }

  return fetchRequestHandler({
    endpoint: "/api/trpc",
    router: appRouter,
    req,
    createContext: createTRPCContext
  });
}

export default handler;
```

</br>

### Creating SSE Stream Procedures

---

```ts
import { observable } from "@trpc/server/observable";
import { OpenAI } from "openai-streams";
import { z } from "zod";
import { createTRPCRouter, publicProcedure } from ".";

export const chatRouter = createTRPCRouter({
  generate: publicProcedure
    .input(
      z.object({
        model: z.string(),
        messages: z.array(
          z.object({
            role: z.enum(["user", "system", "assistant"]),
            content: z.string()
          })
        ),
        temperature: z.number().nullish(),
        top_p: z.number().nullish(),
        frequency_penalty: z.number().nullish(),
        presence_penalty: z.number().nullish(),
        max_tokens: z.number().default(4096),
        n: z.number().nullish(),
        logit_bias: z
          .record(z.string(), z.number().min(-100).max(100))
          .nullish(),
        stop: z.array(z.string()).nullish(),
        user: z.string().nullish()
      })
    )
    .subscription(({ input }) => {
      return observable<string>(observer => {
        const abortController = new AbortController();

        void OpenAI("chat", input, {
          controller: abortController,
          apiKey: process.env.OPEN_AI_API_KEY,
          onParse(token) {
            observer.next(token);
          },
          onDone() {
            observer.complete();
          }
        }).catch(err => {
          observer.error(err);
        });

        return () => {
          abortController.abort();
          observer.complete();
        };
      });
    })
});
```

</br>

## License

ISC License (ISC)

</br>

## Author

Alec Helmturner
