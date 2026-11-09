"use client";

import { useState } from "react";

/** Common props of every setting form: the stored setting and how to show dates. */
export interface FormFrame {
  today: string;
  locale: string;
  timeZone: string;
  currency: string;
}

/** Form state starting from the stored value, with whether it differs and a way back. */
export function useDraft<T>(initial: T) {
  const [value, setValue] = useState<T>(initial);
  const dirty = JSON.stringify(value) !== JSON.stringify(initial);
  return { value, set: setValue, dirty, reset: () => setValue(initial) };
}
