// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { createContext, useContext } from "react";
import { StoreApi } from "zustand";

import { AppBarMenuItem } from "@foxglove/studio-base/components/AppBar/types";
import { LayoutData } from "@foxglove/studio-base/context/CurrentLayoutContext";
import { WorkspaceContextStore } from "@foxglove/studio-base/context/Workspace/WorkspaceContext";
import { SceneExtensionOverrides } from "@foxglove/studio-base/panels/ThreeDeeRender/IRenderer";

interface IAppContext {
  appBarLayoutButton?: JSX.Element;
  appBarMenuItems?: readonly AppBarMenuItem[];
  createEvent?: (args: {
    deviceId: string;
    timestamp: string;
    durationNanos: string;
    metadata: Record<string, string>;
  }) => Promise<void>;
  gatedFeatureStore?: GatedFeatureStore;
  importLayoutFile?: (fileName: string, data: LayoutData) => Promise<void>;
  layoutEmptyState?: JSX.Element;
  syncAdapters?: readonly JSX.Element[];
  workspaceExtensions?: readonly JSX.Element[];
  workspaceStoreCreator?: (
    initialState?: Partial<WorkspaceContextStore>,
  ) => StoreApi<WorkspaceContextStore>;
}
export type GatedFeatureMap = {
  "pro-three-dee": { sceneExtensionOverrides: SceneExtensionOverrides };
};

export type GatedFeatureType = keyof GatedFeatureMap;

export interface GatedFeatureStore {
  useFeature<T extends GatedFeatureType>(feature: T): GatedFeatureMap[T] | undefined;
}
const AppContext = createContext<IAppContext>({});
AppContext.displayName = "AppContext";

export function useAppContext(): IAppContext {
  return useContext(AppContext);
}

export { AppContext };
export type { IAppContext };
