export function readPositiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    const range = maximum === Number.MAX_SAFE_INTEGER ? '正整数' : `1–${maximum} 的整数`;
    throw new Error(`${name} 必须是${range}`);
  }
  return value;
}
