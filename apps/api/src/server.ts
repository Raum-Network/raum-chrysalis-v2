import app, { startBackgroundServices } from "./app.js";
import { env } from "./config/index.js";

const isVercel = Boolean(process.env.VERCEL);

if (!isVercel) {
  app.listen(env.apiPort, () => {
    console.log(`Chrysalis V2 API listening on :${env.apiPort}`);
    startBackgroundServices();
  });
}

export default app;
