/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as analytics from "../analytics.js";
import type * as audit from "../audit.js";
import type * as crons from "../crons.js";
import type * as invites from "../invites.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_constants from "../lib/constants.js";
import type * as lib_domain from "../lib/domain.js";
import type * as lib_scoring from "../lib/scoring.js";
import type * as lib_utils from "../lib/utils.js";
import type * as lib_validators from "../lib/validators.js";
import type * as lib_zod from "../lib/zod.js";
import type * as metrics from "../metrics.js";
import type * as myFunctions from "../myFunctions.js";
import type * as respondent from "../respondent.js";
import type * as sessions from "../sessions.js";
import type * as surveys from "../surveys.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  analytics: typeof analytics;
  audit: typeof audit;
  crons: typeof crons;
  invites: typeof invites;
  "lib/auth": typeof lib_auth;
  "lib/constants": typeof lib_constants;
  "lib/domain": typeof lib_domain;
  "lib/scoring": typeof lib_scoring;
  "lib/utils": typeof lib_utils;
  "lib/validators": typeof lib_validators;
  "lib/zod": typeof lib_zod;
  metrics: typeof metrics;
  myFunctions: typeof myFunctions;
  respondent: typeof respondent;
  sessions: typeof sessions;
  surveys: typeof surveys;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  posthog: {
    lib: {
      alias: FunctionReference<
        "action",
        "internal",
        {
          alias: string;
          apiKey: string;
          disableGeoip?: boolean;
          distinctId: string;
          host: string;
        },
        any
      >;
      capture: FunctionReference<
        "action",
        "internal",
        {
          apiKey: string;
          disableGeoip?: boolean;
          distinctId: string;
          event: string;
          groups?: any;
          host: string;
          properties?: any;
          sendFeatureFlags?: boolean;
          timestamp?: number;
          uuid?: string;
        },
        any
      >;
      captureException: FunctionReference<
        "action",
        "internal",
        {
          additionalProperties?: any;
          apiKey: string;
          distinctId?: string;
          errorMessage: string;
          errorName?: string;
          errorStack?: string;
          host: string;
        },
        any
      >;
      getAllFlags: FunctionReference<
        "action",
        "internal",
        {
          apiKey: string;
          disableGeoip?: boolean;
          distinctId: string;
          flagKeys?: Array<string>;
          groupProperties?: any;
          groups?: any;
          host: string;
          personProperties?: any;
        },
        any
      >;
      getAllFlagsAndPayloads: FunctionReference<
        "action",
        "internal",
        {
          apiKey: string;
          disableGeoip?: boolean;
          distinctId: string;
          flagKeys?: Array<string>;
          groupProperties?: any;
          groups?: any;
          host: string;
          personProperties?: any;
        },
        any
      >;
      getFeatureFlag: FunctionReference<
        "action",
        "internal",
        {
          apiKey: string;
          disableGeoip?: boolean;
          distinctId: string;
          groupProperties?: any;
          groups?: any;
          host: string;
          key: string;
          personProperties?: any;
          sendFeatureFlagEvents?: boolean;
        },
        any
      >;
      getFeatureFlagPayload: FunctionReference<
        "action",
        "internal",
        {
          apiKey: string;
          disableGeoip?: boolean;
          distinctId: string;
          groupProperties?: any;
          groups?: any;
          host: string;
          key: string;
          matchValue?: string | boolean;
          personProperties?: any;
          sendFeatureFlagEvents?: boolean;
        },
        any
      >;
      getFeatureFlagResult: FunctionReference<
        "action",
        "internal",
        {
          apiKey: string;
          disableGeoip?: boolean;
          distinctId: string;
          groupProperties?: any;
          groups?: any;
          host: string;
          key: string;
          personProperties?: any;
          sendFeatureFlagEvents?: boolean;
        },
        any
      >;
      groupIdentify: FunctionReference<
        "action",
        "internal",
        {
          apiKey: string;
          disableGeoip?: boolean;
          distinctId?: string;
          groupKey: string;
          groupType: string;
          host: string;
          properties?: any;
        },
        any
      >;
      identify: FunctionReference<
        "action",
        "internal",
        {
          apiKey: string;
          disableGeoip?: boolean;
          distinctId: string;
          host: string;
          properties?: any;
        },
        any
      >;
      isFeatureEnabled: FunctionReference<
        "action",
        "internal",
        {
          apiKey: string;
          disableGeoip?: boolean;
          distinctId: string;
          groupProperties?: any;
          groups?: any;
          host: string;
          key: string;
          personProperties?: any;
          sendFeatureFlagEvents?: boolean;
        },
        any
      >;
    };
  };
};
