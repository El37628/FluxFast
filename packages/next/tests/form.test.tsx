// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FluxRouter,
  ValidationError,
  createValidator,
  type FluxTransport,
  type MutationEnvelope,
  type MutationTransportRequest,
  type PageEnvelope,
  type VisitTransportRequest
} from "@fluxfast/core";
import { useForm, type UseFormOptions, type UseFormReturn } from "../src/form";
import { FluxProvider } from "../src/provider";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

class MockTransport implements FluxTransport {
  readonly visitMock = vi.fn<
    (request: VisitTransportRequest) => Promise<PageEnvelope>
  >();
  readonly mutateMock = vi.fn<
    (request: MutationTransportRequest) => Promise<MutationEnvelope>
  >();

  visit(request: VisitTransportRequest): Promise<PageEnvelope> {
    return this.visitMock(request);
  }

  mutate(request: MutationTransportRequest): Promise<MutationEnvelope> {
    return this.mutateMock(request);
  }
}

const mounted = new Set<{ root: Root; router: FluxRouter }>();

async function mountForm<T extends Record<string, any>>(
  initialValues: T,
  options?: UseFormOptions<T>
): Promise<{
  form: () => UseFormReturn<T>;
  transport: MockTransport;
}> {
  const transport = new MockTransport();
  const router = new FluxRouter({
    transport,
    deferHistory: true,
    initialPage: { component: "forms/test", url: "/forms/test" }
  });
  let current: UseFormReturn<T> | undefined;

  function Probe() {
    current = useForm(initialValues, options);
    return null;
  }

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.add({ root, router });
  await act(async () => {
    root.render(
      <FluxProvider router={router}>
        <Probe />
      </FluxProvider>
    );
  });

  return {
    form: () => {
      if (!current) throw new Error("Form probe has not rendered");
      return current;
    },
    transport
  };
}

afterEach(async () => {
  for (const entry of mounted) {
    await act(async () => entry.root.unmount());
    entry.router.destroy();
  }
  mounted.clear();
  document.body.replaceChildren();
});

describe("useForm validation", () => {
  it("preserves submission behavior when no validator is configured", async () => {
    const { form, transport } = await mountForm({ name: "Garden Suite" });
    transport.mutateMock.mockResolvedValue({
      protocol: "fluxfast/1",
      mutation: {}
    });
    const onSuccess = vi.fn();
    const preventDefault = vi.fn();

    await act(async () => {
      await form().submit("/rooms", { method: "PATCH", onSuccess })({
        preventDefault
      } as never);
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(transport.mutateMock).toHaveBeenCalledWith(expect.objectContaining({
      url: "/rooms",
      data: { name: "Garden Suite" },
      method: "PATCH"
    }));
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(form()).toMatchObject({
      processing: false,
      wasSuccessful: true,
      recentlySuccessful: true,
      errors: {},
      issues: []
    });
    expect(form().validate()).toBe(true);
  });

  it("records nested client issues and sends no invalid request", async () => {
    const validator = createValidator<{
      email: string;
      address: { city: string };
    }>({
      kind: "object",
      properties: {
        email: { kind: "string", format: "email" },
        address: {
          kind: "object",
          properties: { city: { kind: "string", minLength: 2 } },
          required: ["city"]
        }
      },
      required: ["email", "address"]
    });
    const validate = vi.fn((value: unknown) => validator.validate(value));
    const { form, transport } = await mountForm(
      { email: "invalid", address: { city: "" } },
      { validator: { ...validator, validate } }
    );
    const onError = vi.fn();

    await act(async () => {
      await form().submit("/register", { onError })();
    });

    expect(transport.mutateMock).not.toHaveBeenCalled();
    expect(validate).toHaveBeenCalledOnce();
    expect(form().processing).toBe(false);
    expect(form().wasSuccessful).toBe(false);
    expect(form().issues.map(issue => issue.path)).toEqual(expect.arrayContaining([
      ["email"],
      ["address", "city"]
    ]));
    expect(form().errors).toEqual({
      email: "String does not match the email format.",
      address: "String must contain at least 2 characters."
    });
    expect(form().errorMap).toEqual({
      email: "String does not match the email format.",
      "address.city": "String must contain at least 2 characters."
    });
    expect(onError).toHaveBeenCalledWith(form().errors);
  });

  it("supports manual validation and selective nested error clearing", async () => {
    const validator = createValidator<{
      profile: { name: string };
      count: number;
    }>({
      kind: "object",
      properties: {
        profile: {
          kind: "object",
          properties: { name: { kind: "string", minLength: 2 } },
          required: ["name"]
        },
        count: { kind: "integer", minimum: 1 }
      },
      required: ["profile", "count"]
    });
    const validate = vi.fn((value: unknown) => validator.validate(value));
    const { form } = await mountForm(
      { profile: { name: "" }, count: 0 },
      { validator: { ...validator, validate } }
    );

    let valid = true;
    await act(async () => {
      valid = form().validate();
    });
    expect(valid).toBe(false);
    expect(form().errorMap).toEqual({
      "profile.name": "String must contain at least 2 characters.",
      count: "Value must be at least 1."
    });

    await act(async () => form().clearErrors("profile"));
    expect(form().issues.map(issue => issue.path)).toEqual([["count"]]);
    expect(form().errors).toEqual({ count: "Value must be at least 1." });

    await act(async () => {
      form().setData({ profile: { name: "Ada" }, count: 2 });
      valid = form().validate();
    });
    expect(valid).toBe(true);
    expect(validate).toHaveBeenCalledTimes(2);
    expect(form().issues).toEqual([]);
    expect(form().errorMap).toEqual({});
  });

  it.each([
    ["email", "Email is already registered"],
    ["address.postcode", "Postcode is not serviceable"],
    ["addresses[0].postcode", "Postcode is not serviceable"]
  ])(
    "keeps authoritative server validation at the canonical %s path",
    async (serverPath, serverMessage) => {
      const validator = createValidator<{
        email: string;
        address: { postcode: string };
        addresses: Array<{ postcode: string }>;
      }>({
        kind: "object",
        properties: {
          email: { kind: "string", format: "email" },
          address: {
            kind: "object",
            properties: { postcode: { kind: "string", minLength: 3 } },
            required: ["postcode"]
          },
          addresses: {
            kind: "array",
            items: {
              kind: "object",
              properties: { postcode: { kind: "string", minLength: 3 } },
              required: ["postcode"]
            }
          }
        },
        required: ["email", "address", "addresses"]
      });
      const { form, transport } = await mountForm(
        {
          email: "ada@example.com",
          address: { postcode: "99999" },
          addresses: [{ postcode: "99999" }]
        },
        { validator }
      );
      let rejectRequest: ((reason?: unknown) => void) | undefined;
      transport.mutateMock.mockImplementationOnce(() =>
        new Promise<MutationEnvelope>((_resolve, reject) => {
          rejectRequest = reject;
        })
      );
      const onError = vi.fn();
      let submission: Promise<void> | undefined;

      await act(async () => {
        submission = form().submit("/register", { onError })();
        await Promise.resolve();
      });

      expect(rejectRequest).toBeDefined();
      expect(form().processing).toBe(true);
      expect(form().wasSuccessful).toBe(false);
      expect(form().recentlySuccessful).toBe(false);

      await act(async () => {
        rejectRequest!(
          new ValidationError("Request validation failed", {
            [serverPath]: [serverMessage]
          })
        );
        await submission!;
      });

      expect(transport.mutateMock).toHaveBeenCalledOnce();
      expect(form().issues).toEqual([]);
      expect(form().errors).toEqual({
        [serverPath]: serverMessage
      });
      expect(form().errorMap).toEqual({
        [serverPath]: serverMessage
      });
      expect(form().processing).toBe(false);
      expect(form().wasSuccessful).toBe(false);
      expect(form().recentlySuccessful).toBe(false);
      expect(onError).toHaveBeenCalledWith({
        [serverPath]: serverMessage
      });

      await act(async () => form().setError("email", "Manual email error"));
      expect(form().errorMap).toEqual({
        [serverPath]: serverMessage,
        email: "Manual email error"
      });

      await act(async () => form().clearErrors("email"));
      expect(form().errorMap).toEqual(
        serverPath === "email" ? {} : { [serverPath]: serverMessage }
      );

      await act(async () => form().clearErrors());
      expect(form().errors).toEqual({});
      expect(form().errorMap).toEqual({});

      let valid = false;
      await act(async () => {
        valid = form().validate();
      });
      expect(valid).toBe(true);

      transport.mutateMock.mockResolvedValueOnce({
        protocol: "fluxfast/1",
        mutation: {}
      });
      const onSuccess = vi.fn();
      await act(async () => {
        await form().submit("/register", { onSuccess })();
      });

      expect(transport.mutateMock).toHaveBeenCalledTimes(2);
      expect(onSuccess).toHaveBeenCalledOnce();
      expect(form()).toMatchObject({
        processing: false,
        wasSuccessful: true,
        recentlySuccessful: true,
        errors: {},
        issues: []
      });
      expect(form().errorMap).toEqual({});
    }
  );

  it("keeps manual errors additive and lets local issues take precedence", async () => {
    const validator = createValidator<{ name: string }>({
      kind: "object",
      properties: { name: { kind: "string", minLength: 2 } },
      required: ["name"]
    });
    const { form } = await mountForm({ name: "" }, { validator });

    await act(async () => {
      form().setError("name", "Manual error");
      form().validate();
    });

    expect(form().errors).toEqual({
      name: "String must contain at least 2 characters."
    });
    expect(form().errorMap).toEqual({
      name: "String must contain at least 2 characters."
    });
  });
});
