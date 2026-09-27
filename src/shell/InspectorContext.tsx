import { createContext, useContext } from "react";

/**
 * The Info panel (#184): a column beside the chat that opens only when the
 * owner asks — from the chat header's info button or ⌘I — the way a
 * messenger's contact info does. The shell knows whether there is room and
 * something to show, so it says; a chat header only renders the button.
 */
export interface InfoPanelState {
  /** There is room for the column and something to show in it. */
  readonly available: boolean;
  readonly open: boolean;
  readonly toggle: () => void;
}

const InfoPanel = createContext<InfoPanelState>({ available: false, open: false, toggle: () => {} });

export const InfoPanelProvider = InfoPanel.Provider;

export function useInfoPanel(): InfoPanelState {
  return useContext(InfoPanel);
}
