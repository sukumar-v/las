/**
 * ESLint plugin for LAS's "no fixed design language" rule.
 *
 * Component and screen code may only reference theme tokens (CSS custom properties
 * named --las-*) and component variants (data attributes). Any literal color, font
 * family, radius, shadow or pixel font size in component code fails the build.
 */
const HEX = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/;
const COLOR_FN = /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\s*\(/;
const NAMED_COLOR = /(?:^|[\s:;,])(?:red|blue|green|black|white|gray|grey|orange|purple|pink|yellow|teal|navy|maroon|olive|lime|aqua|silver|fuchsia|crimson|tomato|gold|salmon|coral|indigo|violet)(?:$|[\s;,])/i;
const FONT_FAMILY = /font-family\s*:\s*(?!var\(--las-)/i;
const RADIUS = /border-radius\s*:\s*(?!var\(--las-)(?!0(?:px)?\s*[;"'`]|0$)/i;
const SHADOW = /box-shadow\s*:\s*(?!var\(--las-)(?!none)/i;
const FONT_SIZE_PX = /font-size\s*:\s*\d/i;
const FONT_NAMES = /\b(?:Inter|Roboto|Helvetica|Arial|Georgia|Times New Roman|Gabarito|Atkinson Hyperlegible|DM Mono|Fraunces|Literata|IBM Plex|Space Grotesk|Space Mono|Menlo|Monaco|Courier New|Comic Sans|Poppins|Montserrat|Lato|Nunito|Playfair)\b/;

const JSX_STYLE_KEYS = {
  color: [HEX, COLOR_FN, NAMED_COLOR],
  background: [HEX, COLOR_FN, NAMED_COLOR],
  backgroundColor: [HEX, COLOR_FN, NAMED_COLOR],
  borderColor: [HEX, COLOR_FN, NAMED_COLOR],
  fill: [HEX, COLOR_FN, NAMED_COLOR],
  stroke: [HEX, COLOR_FN, NAMED_COLOR],
  fontFamily: [/.*/],
  borderRadius: [/^\s*\d/],
  boxShadow: [/\d/],
  fontSize: [/^\s*\d/]
};

function checkString(value, report, node) {
  if (typeof value !== "string") return;
  if (HEX.test(value)) return report(node, `hard-coded color "${value.match(HEX)[0]}": use a theme role (var(--las-color-*))`);
  if (COLOR_FN.test(value)) return report(node, `hard-coded color function in "${value}": use a theme role`);
  if (FONT_FAMILY.test(value)) return report(node, `hard-coded font-family: use var(--las-font-*)`);
  if (FONT_NAMES.test(value) && /font/i.test(value)) return report(node, `hard-coded font name: use var(--las-font-*)`);
  if (RADIUS.test(value)) return report(node, `hard-coded border-radius: use var(--las-radius-*)`);
  if (SHADOW.test(value)) return report(node, `hard-coded box-shadow: use var(--las-shadow-*)`);
  if (FONT_SIZE_PX.test(value)) return report(node, `hard-coded font-size: use var(--las-text-*)`);
}

const rule = {
  meta: {
    type: "problem",
    docs: { description: "Disallow hard-coded colors, fonts, radii and shadows in component code; everything comes from the learner's theme." },
    schema: []
  },
  create(context) {
    const report = (node, message) => context.report({ node, message });
    return {
      Literal(node) {
        checkString(node.value, report, node);
      },
      TemplateElement(node) {
        checkString(node.value.cooked ?? node.value.raw, report, node);
      },
      Property(node) {
        const key = node.key && (node.key.name || node.key.value);
        const checks = key && JSX_STYLE_KEYS[key];
        if (!checks) return;
        const v = node.value;
        if (v.type === "Literal" && typeof v.value === "string") {
          if (/^var\(--las-/.test(v.value) || v.value === "none" || v.value === "0" || v.value === "inherit" || v.value === "currentColor" || v.value === "transparent") return;
          if (checks.some((re) => re.test(v.value))) report(node, `hard-coded style "${key}": use a theme token`);
        }
      }
    };
  }
};

export default { rules: { "no-hardcoded-style": rule } };
