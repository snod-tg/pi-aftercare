import "dotenv/config";

const port = Number(process.env.PORT ?? "3000");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer from 1 to 65535");
}

export const config = {
  host: process.env.HOST ?? "127.0.0.1",
  port,
};
