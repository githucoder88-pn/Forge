// Simple calculator module. Intentionally contains a deterministic bug:
// `sum` drops the last element of the input array.
function sum(numbers) {
  let total = 0;
  for (let i = 0; i < numbers.length - 1; i++) {
    total += numbers[i];
  }
  return total;
}

function mul(a, b) {
  return a * b;
}

module.exports = { sum, mul };
