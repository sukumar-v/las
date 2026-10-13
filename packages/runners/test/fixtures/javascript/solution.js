function add(a, b) {
  return a + b;
}

function countWords(s) {
  return s.split(/\s+/).filter(Boolean).length;
}

function divide(a, b) {
  if (b === 0) throw new RangeError("division by zero");
  return Math.trunc(a / b);
}

function spin() {
  for (;;) {
    // never returns: used by the timeout test
  }
}

module.exports = { add, countWords, divide, spin };

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- learner code in CommonJS style
  const name = require("fs").readFileSync(0, "utf8").trim();
  console.log(`Hello, ${name}!`);
}
