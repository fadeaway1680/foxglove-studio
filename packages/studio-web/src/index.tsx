// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { StrictMode, useEffect } from "react";
import ReactDOM from "react-dom";
import { RouterProvider, createBrowserRouter } from "react-router-dom";

import Logger from "@foxglove/log";
import CssBaseline from "@foxglove/studio-base/components/CssBaseline";

import { CompatibilityBanner } from "./CompatibilityBanner";
import { canRenderApp } from "./canRenderApp";

type Router = ReturnType<typeof createBrowserRouter>;

const log = Logger.getLogger(__filename);

function LogAfterRender(props: React.PropsWithChildren): JSX.Element {
  useEffect(() => {
    // Integration tests look for this console log to indicate the app has rendered once
    // We use console.debug to bypass our logging library which hides some log levels in prod builds
    console.debug("App rendered");
  }, []);
  return <>{props.children}</>;
}

export async function main(getRouter: () => Promise<Router>): Promise<void> {
  log.debug("initializing");

  window.onerror = (...args) => {
    console.error(...args);
  };

  const rootEl = document.getElementById("root");
  if (!rootEl) {
    throw new Error("missing #root element");
  }

  const chromeMatch = navigator.userAgent.match(/Chrome\/(\d+)\./);
  const chromeVersion = chromeMatch ? parseInt(chromeMatch[1] ?? "", 10) : 0;
  const isChrome = chromeVersion !== 0;

  const canRender = canRenderApp();
  const banner = (
    <CompatibilityBanner
      isChrome={isChrome}
      currentVersion={chromeVersion}
      isDismissable={canRender}
    />
  );

  if (!canRender) {
    // eslint-disable-next-line react/no-deprecated
    ReactDOM.render(
      <StrictMode>
        <LogAfterRender>
          <CssBaseline>{banner}</CssBaseline>
        </LogAfterRender>
      </StrictMode>,
      rootEl,
    );
    return;
  }

  const { installDevtoolsFormatters, overwriteFetch, waitForFonts, initI18n } = await import(
    "@foxglove/studio-base"
  );
  installDevtoolsFormatters();
  overwriteFetch();
  // consider moving waitForFonts into App to display an app loading screen
  await waitForFonts();
  await initI18n();

  const router = await getRouter();

  // eslint-disable-next-line react/no-deprecated
  ReactDOM.render(
    <StrictMode>
      <LogAfterRender>
        {banner}
        <RouterProvider router={router} />
      </LogAfterRender>
    </StrictMode>,
    rootEl,
  );
}
