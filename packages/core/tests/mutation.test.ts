import { describe, it, expect } from "vitest";
import { applyPatchToValue } from "../src/mutation";
import { ResourceStore } from "../src/store";

describe("Mutation Patch Operators", () => {
  it("applies replace-resource", () => {
    const res = applyPatchToValue({ old: 1 }, { op: "replace-resource", value: { new: 2 } });
    expect(res).toEqual({ new: 2 });
  });

  it("applies merge-object", () => {
    const current = { a: 1, b: 2 };
    const res = applyPatchToValue(current, { op: "merge-object", value: { b: 20, c: 3 } });
    expect(res).toEqual({ a: 1, b: 20, c: 3 });
  });

  it("applies replace-item in array by id", () => {
    const list = [
      { id: 101, status: "dirty" },
      { id: 102, status: "clean" },
    ];
    const res = applyPatchToValue(list, {
      op: "replace-item",
      id: 101,
      value: { id: 101, status: "clean" },
    });
    expect(res).toEqual([
      { id: 101, status: "clean" },
      { id: 102, status: "clean" },
    ]);
  });

  it("applies remove-item in array by id", () => {
    const list = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const res = applyPatchToValue(list, { op: "remove-item", id: 2 });
    expect(res).toEqual([{ id: 1 }, { id: 3 }]);
  });

  it("applies append-item in array", () => {
    const list = [{ id: 1 }];
    const res = applyPatchToValue(list, { op: "append-item", value: { id: 2 } });
    expect(res).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("applies patches through ResourceStore.patch()", () => {
    const store = new ResourceStore();
    store.set({
      key: "rooms",
      version: "v1",
      value: [{ id: 101, status: "dirty" }],
    });

    store.patch("rooms", [
      {
        op: "replace-item",
        id: 101,
        value: { id: 101, status: "occupied" },
      },
    ]);

    const updated = store.getSnapshot<any[]>("rooms");
    expect(updated).toEqual([{ id: 101, status: "occupied" }]);
  });
});

