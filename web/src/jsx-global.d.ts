// @types/react 19 scopes the JSX namespace under React.JSX instead of the
// global namespace. Restore the global alias so existing `JSX.Element`
// annotations keep resolving after the React 19 types bump.
import type * as React from "react";

declare global {
  namespace JSX {
    type Element = React.JSX.Element;
  }
}

export {};
