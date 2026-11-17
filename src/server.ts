import { startGateway } from "./app.ts";

const running = await startGateway();
console.log(`AI gateway listening on ${running.url}`);
