/// <reference types="vite/client" />

// Test helper for apps consuming this component with convex-test:
//
//   import { registerZsign } from "@zsign/convex/test";
//   const t = convexTest(schema, modules);
//   registerZsign(t);

import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import schema from "./component/schema.js";

const modules = import.meta.glob("./component/**/*.ts");

export function registerZsign<
  Schema extends SchemaDefinition<GenericSchema, boolean>,
>(t: TestConvex<Schema>) {
  t.registerComponent("zsign", schema, modules);
}

export { schema, modules };
