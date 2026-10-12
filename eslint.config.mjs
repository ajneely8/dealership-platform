import next from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = [
  { ignores: [".next/**", "node_modules/**", "drizzle/**", "next-env.d.ts", ".data/**"] },
  ...next,
  ...nextTs,
  {
    // Every page here is an async server component rendered once per request, so reading the
    // clock during render is correct. The purity rule is aimed at client components.
    rules: { "react-hooks/purity": "off" },
  },
];

export default config;
