import type { AnyRouter } from "@trpc/server";

type ProcedureRecord<T> = T extends { _def: { record: Record<string, any> } }
  ? {
      [K in keyof T["_def"]["record"]]: ProcedureRecord<T["_def"]["record"][K]>;
    }
  : false;

type DotPrefix<T extends string> = T extends "" ? "" : `.${T}`;

type DotNestedKeys<T> = (
  T extends object
    ? {
        [K in Exclude<keyof T, symbol>]: `${K}${DotPrefix<
          DotNestedKeys<T[K]>
        >}`;
      }[Exclude<keyof T, symbol>]
    : never
) extends infer D
  ? Extract<D, string>
  : never;

//TODO: Find a way to create a union with paths to subscription procedures only
export type ProcedurePath<TRouter extends AnyRouter> = DotNestedKeys<
  ProcedureRecord<TRouter>
>;
