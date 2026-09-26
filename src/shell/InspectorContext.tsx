import { createContext, useContext } from "react";

/**
 * Whether the inspector column is on screen beside the chat. When it is, a
 * draft's why is already at zero clicks and the tray needs no "Why?" button;
 * when it isn't (a phone, a narrow window, or the column turned off) the tray
 * offers it as a sheet. The shell is the one that knows, so it says.
 */
const InspectorVisible = createContext(false);

export const InspectorVisibleProvider = InspectorVisible.Provider;

export function useInspectorVisible(): boolean {
  return useContext(InspectorVisible);
}
