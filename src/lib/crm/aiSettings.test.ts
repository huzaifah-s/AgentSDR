import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CrmConfigurationValidationError } from "./categories";
import { parseAiInstructionsPatch } from "./aiSettings";

const UUID = "123e4567-e89b-42d3-a456-426614174000";

function block(id: string, title = "Tone", content = "Be brief.") {
  return { id, title, content };
}

describe("parseAiInstructionsPatch", () => {
  test("returns only the fields present, with titles and content trimmed", () => {
    assert.deepEqual(
      parseAiInstructionsPatch({ draftInstructions: [block("a", "  Tone ", "  Be brief.  ")] }),
      { draftInstructions: [block("a", "Tone", "Be brief.")] },
    );
  });

  test("null and an empty list both clear a field", () => {
    assert.deepEqual(
      parseAiInstructionsPatch({ pipelineId: UUID, draftInstructions: [], classificationInstructions: null }),
      { pipelineId: UUID, draftInstructions: null, classificationInstructions: null },
    );
  });

  test("an empty body changes nothing", () => {
    assert.deepEqual(parseAiInstructionsPatch({}), {});
  });

  test("keeps empty blocks the user is still writing, in order", () => {
    const blocks = [block("b", "", ""), block("a")];
    assert.deepEqual(parseAiInstructionsPatch({ classificationInstructions: blocks }).classificationInstructions, blocks);
  });

  test("enforces the per-block, block-count and total caps", () => {
    assert.equal(
      parseAiInstructionsPatch({ draftInstructions: [block("a", "T", "a".repeat(8000))] }).draftInstructions?.[0]?.content.length,
      8000,
    );
    for (const draftInstructions of [
      [block("a", "T", "a".repeat(8001))],
      [block("a", "t".repeat(201))],
      Array.from({ length: 51 }, (_, index) => block(`b${index}`)),
      [block("a", "A", "a".repeat(7000)), block("b", "B", "b".repeat(7000)), block("c", "C", "c".repeat(7000))],
    ]) {
      assert.throws(() => parseAiInstructionsPatch({ draftInstructions }), CrmConfigurationValidationError);
    }
  });

  test("rejects bad shapes, ids and keys", () => {
    for (const body of [
      { draftInstructions: "text" },
      { draftInstructions: ["x"] },
      { draftInstructions: [{ id: "a", title: "T" }] },
      { draftInstructions: [{ ...block("a"), extra: 1 }] },
      { draftInstructions: [block("has space")] },
      { draftInstructions: [block("a"), block("a")] },
      { draftInstructions: [{ id: "a", title: 1, content: "x" }] },
      { other: "x" },
      { pipelineId: "nope" },
      null,
      [],
      "text",
    ]) {
      assert.throws(() => parseAiInstructionsPatch(body), CrmConfigurationValidationError);
    }
  });
});

describe("parseAiInstructionsPatch callingInstructions", () => {
  test("accepts calling instructions, and null or an empty list as back to the defaults", () => {
    const blocks = [{ id: "a", title: "Opening", content: "Say hi." }];
    assert.deepEqual(parseAiInstructionsPatch({ callingInstructions: blocks }).callingInstructions, blocks);
    assert.equal(parseAiInstructionsPatch({ callingInstructions: null }).callingInstructions, null);
    assert.equal(parseAiInstructionsPatch({ callingInstructions: [] }).callingInstructions, null);
  });
  test("refuses malformed blocks", () => {
    assert.throws(() => parseAiInstructionsPatch({ callingInstructions: [{ id: "a", title: 1, content: "x" }] }), CrmConfigurationValidationError);
  });
});

describe("parseAiInstructionsPatch postInstructions", () => {
  test("accepts the LinkedIn content brief, and null or an empty list as back to the defaults", () => {
    const blocks = [{ id: "never-post", title: "What we never post", content: "Prices." }];
    assert.deepEqual(parseAiInstructionsPatch({ postInstructions: blocks }).postInstructions, blocks);
    assert.equal(parseAiInstructionsPatch({ postInstructions: null }).postInstructions, null);
    assert.equal(parseAiInstructionsPatch({ postInstructions: [] }).postInstructions, null);
    assert.equal(parseAiInstructionsPatch({ callingInstructions: null }).postInstructions, undefined);
  });
  test("refuses malformed blocks", () => {
    assert.throws(() => parseAiInstructionsPatch({ postInstructions: [{ id: "a b", title: "x", content: "x" }] }), CrmConfigurationValidationError);
  });
});
