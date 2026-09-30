import { useRef } from "react";

/**
 * The last non-null value, kept while `value` is null. A dialog whose body
 * is built from a target ("Leave {room}?") would otherwise lose its words
 * the instant the target clears, mid-exit.
 */
export function useHeld<T>(value: T | null): T | null {
  const held = useRef<T | null>(value);
  if (value !== null) {
    held.current = value;
  }
  return held.current;
}
