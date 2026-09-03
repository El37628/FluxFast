"use client";

import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type FormEvent
} from "react";
import {
  ValidationError,
  formatValidationPath,
  type FluxValidator,
  type ValidationIssue
} from "@fluxfast/core";
import { useRouter } from "./hooks";

const EMPTY_ISSUES = Object.freeze([]) as readonly ValidationIssue[];
const EMPTY_ERROR_MAP = Object.freeze(
  Object.create(null) as Record<string, string>
) as Readonly<Record<string, string>>;

export interface FormOptions {
  method?: string;
  onSuccess?: () => void;
  onError?: (errors: Record<string, string>) => void;
  preserveScroll?: boolean;
}

export interface UseFormOptions<T extends Record<string, any>> {
  validator?: FluxValidator<T>;
}

export interface UseFormReturn<T extends Record<string, any>> {
  data: T;
  errors: Partial<Record<keyof T, string>>;
  issues: readonly ValidationIssue[];
  errorMap: Readonly<Record<string, string>>;
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
  validate: () => boolean;
  submit: (
    url: string,
    options?: FormOptions
  ) => (e?: FormEvent<HTMLFormElement>) => Promise<void>;
}

function issuesToTopLevelErrors<T extends Record<string, any>>(
  issues: readonly ValidationIssue[]
): Partial<Record<keyof T, string>> {
  const errors = Object.create(null) as Partial<Record<keyof T, string>>;
  for (const issue of issues) {
    const key = issue.path[0];
    if (
      typeof key === "string" &&
      !Object.prototype.hasOwnProperty.call(errors, key)
    ) {
      errors[key as keyof T] = issue.message;
    }
  }
  return errors;
}

function issuesToErrorMap(
  issues: readonly ValidationIssue[]
): Readonly<Record<string, string>> {
  if (issues.length === 0) return EMPTY_ERROR_MAP;
  const errorMap = Object.create(null) as Record<string, string>;
  for (const issue of issues) {
    const path = formatValidationPath(issue.path);
    if (!Object.prototype.hasOwnProperty.call(errorMap, path)) {
      errorMap[path] = issue.message;
    }
  }
  return Object.freeze(errorMap);
}

export function useForm<T extends Record<string, any>>(
  initialValues: T,
  formOptions: UseFormOptions<T> = {}
): UseFormReturn<T> {
  const router = useRouter();
  const initialRef = useRef<T>(initialValues);
  const [data, setDataState] = useState<T>(initialValues);
  const dataRef = useRef<T>(initialValues);
  const [manualErrors, setManualErrors] = useState<Partial<Record<keyof T, string>>>({});
  const [issues, setIssues] = useState<readonly ValidationIssue[]>(EMPTY_ISSUES);
  const [processing, setProcessing] = useState<boolean>(false);
  const [wasSuccessful, setWasSuccessful] = useState<boolean>(false);
  const [recentlySuccessful, setRecentlySuccessful] = useState<boolean>(false);
  const recentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const localErrors = useMemo(() => issuesToTopLevelErrors<T>(issues), [issues]);
  const errors = useMemo(
    () => ({ ...manualErrors, ...localErrors }),
    [manualErrors, localErrors]
  );
  const localErrorMap = useMemo(() => issuesToErrorMap(issues), [issues]);
  const errorMap = useMemo(() => {
    const entries = Object.entries(manualErrors);
    if (entries.length === 0) return localErrorMap;
    const combined = Object.create(null) as Record<string, string>;
    for (const [key, message] of entries) {
      if (message !== undefined) combined[key] = message;
    }
    for (const [path, message] of Object.entries(localErrorMap)) {
      combined[path] = message;
    }
    return Object.freeze(combined);
  }, [manualErrors, localErrorMap]);

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
    setManualErrors(prev => ({ ...prev, [key]: message }));
  }, []);

  const clearErrors = useCallback((...keys: (keyof T)[]) => {
    if (keys.length === 0) {
      setManualErrors({});
      setIssues(EMPTY_ISSUES);
    } else {
      const selected = new Set<keyof T>(keys);
      setManualErrors(prev => {
        const next = { ...prev };
        for (const k of keys) {
          delete next[k];
        }
        return next;
      });
      setIssues(prev => {
        const next = prev.filter(issue => {
          const key = issue.path[0];
          return typeof key !== "string" || !selected.has(key as keyof T);
        });
        return next.length === prev.length ? prev : Object.freeze(next);
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

  const validateCurrent = useCallback(() => {
    const validator = formOptions.validator;
    return validator?.validate(dataRef.current);
  }, [formOptions.validator]);

  const validate = useCallback((): boolean => {
    const result = validateCurrent();
    if (!result || result.valid) {
      setIssues(EMPTY_ISSUES);
      return true;
    }
    setIssues(result.issues);
    return false;
  }, [validateCurrent]);

  const submit = useCallback(
    (url: string, options?: FormOptions) => {
      return async (e?: FormEvent<HTMLFormElement>) => {
        if (e && typeof e.preventDefault === "function") {
          e.preventDefault();
        }

        setWasSuccessful(false);
        clearErrors();

        const validationResult = validateCurrent();
        if (validationResult && !validationResult.valid) {
          setIssues(validationResult.issues);
          if (options?.onError) {
            options.onError({
              ...issuesToTopLevelErrors<T>(validationResult.issues)
            } as Record<string, string>);
          }
          return;
        }
        setIssues(EMPTY_ISSUES);

        setProcessing(true);

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
            const formattedErrors = Object.create(null) as Partial<
              Record<keyof T, string>
            >;
            for (const [k, v] of Object.entries(err.details)) {
              formattedErrors[k as keyof T] = Array.isArray(v) ? v[0] : String(v);
            }
            setManualErrors(formattedErrors);
            setIssues(EMPTY_ISSUES);
            if (options?.onError) {
              options.onError({ ...formattedErrors } as Record<string, string>);
            }
          } else {
            throw err;
          }
        } finally {
          setProcessing(false);
        }
      };
    },
    [router, clearErrors, validateCurrent]
  );

  return {
    data,
    errors,
    issues,
    errorMap,
    processing,
    wasSuccessful,
    recentlySuccessful,
    setData,
    setError,
    clearErrors,
    reset,
    validate,
    submit,
  };
}
