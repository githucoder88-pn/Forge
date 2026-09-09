// Plain assertion runner (deliberately NOT node:test: the Forge E2E suite itself
// runs under node --test, and nested node --test invocations are skipped).
const assert = require("node:assert/strict");
const { sum, mul } = require("../src/calculator.js");

assert.equal(sum([1, 2, 3, 4]), 10, "sum([1,2,3,4]) should be 10");
assert.equal(sum([]), 0, "sum([]) should be 0");
assert.equal(mul(3, 4), 12, "mul(3,4) should be 12");
console.log("all fixture tests passed");
