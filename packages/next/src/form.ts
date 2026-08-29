"use client";

import { useState, useCallback, useEffect, useRef, FormEvent } from "react";
import { ValidationError } from "@fluxfast/core";
import { useRouter } from "./hooks";

export interface FormOptions {
  method?: string;
  onSuccess?: () => void;
  onError?: (errors: Record<string, string>) => void;
  preserveScroll?: boolean;
}

export interface UseFormReturn<T extends Record<string, any>> {
  data: T;
  errors: Partial<Record<keyof T, string>>;
  processing: boolean;
  wasSuccessful: boolean;
  recentlySuccessful: boolean;
  setData: {
    <K extends keyof T>(key: K, value: T[K]): void;
    (values: Partial<T> | ((prev: T) => T)): void;
  };
  setError: (key: keyof T, message: string) => void;
  clearErrors: (...keys: (keyof T)[]) => void;
  reset: (...keys: (keyof T)[]) => void;
  submit: (
    url: string,
    options?: FormOptions
  ) => (e?: FormEvent<HTMLFormElement>) => Promise<void>;
}

export function useForm<T extends Record<string, any>>(initialValues: T): UseFormReturn<T> {
  const router = useRouter();
  const initialRef = useRef<T>(initialValues);
  const [data, setDataState] = useState<T>(initialValues);
  const dataRef = useRef<T>(initialValues);
  const [errors, setErrors] = useState<Partial<Record<keyof T, string>>>({});
  const [processing, setProcessing] = useState<boolean>(false);
  const [wasSuccessful, setWasSuccessful] = useState<boolean>(false);
  const [recentlySuccessful, setRecentlySuccessful] = useState<boolean>(false);
  const recentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (recentTimerRef.current) clearTimeout(recentTimerRef.current);
  }, []);

  const setData = useCallback((keyOrValues: any, maybeValue?: any) => {
    if (typeof keyOrValues === "string") {
      const next = { ...dataRef.current, [keyOrValues]: maybeValue };
      dataRef.current = next;
      setDataState(next);
    } else if (typeof keyOrValues === "function") {
      const next = keyOrValues(dataRef.current);
      dataRef.current = next;
      setDataState(next);
    } else {
      const next = { ...dataRef.current, ...keyOrValues };
      dataRef.current = next;
      setDataState(next);
    }
  }, []);

  const setError = useCallback((key: keyof T, message: string) => {
    setErrors(prev => ({ ...prev, [key]: message }));
  }, []);

  const clearErrors = useCallback((...keys: (keyof T)[]) => {
    if (keys.length === 0) {
      setErrors({});
    } else {
      setErrors(prev => {
        const next = { ...prev };
        for (const k of keys) {
          delete next[k];
        }
        return next;
      });
    }
  }, []);

  const reset = useCallback((...keys: (keyof T)[]) => {
    if (keys.length === 0) {
      dataRef.current = initialRef.current;
      setDataState(initialRef.current);
    } else {
      const next = { ...dataRef.current };
      for (const k of keys) next[k] = initialRef.current[k];
      dataRef.current = next;
      setDataState(next);
    }
  }, []);

  const submit = useCallback(
    (url: string, options?: FormOptions) => {
      return async (e?: FormEvent<HTMLFormElement>) => {
        if (e && typeof e.preventDefault === "function") {
          e.preventDefault();
        }

        setProcessing(true);
        setWasSuccessful(false);
        clearErrors();

        try {
          await router.mutate(url, dataRef.current, {
            method: options?.method || "POST",
            preserveScroll: options?.preserveScroll,
          });

          setWasSuccessful(true);
          setRecentlySuccessful(true);
          if (recentTimerRef.current) {
            clearTimeout(recentTimerRef.current);
          }
          recentTimerRef.current = setTimeout(() => {
            setRecentlySuccessful(false);
          }, 2000);

          if (options?.onSuccess) {
            options.onSuccess();
          }
        } catch (err: any) {
          if (err instanceof ValidationError && err.details) {
            const formattedErrors: Partial<Record<keyof T, string>> = {};
            for (const [k, v] of Object.entries(err.details)) {
              formattedErrors[k as keyof T] = Array.isArray(v) ? v[0] : String(v);
            }
            setErrors(formattedErrors);
            if (options?.onError) {
              options.onError(formattedErrors as Record<string, string>);
            }
          } else {
            throw err;
          }
        } finally {
          setProcessing(false);
        }
      };
    },
    [router, clearErrors]
  );

  return {
    data,
    errors,
    processing,
    wasSuccessful,
    recentlySuccessful,
    setData,
    setError,
    clearErrors,
    reset,
    submit,
  };
}
