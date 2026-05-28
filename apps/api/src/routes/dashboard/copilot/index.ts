import { Hono } from "hono";
import { copilotCredentialsRoute } from "./credentials";
import { copilotThreadsRoute } from "./threads";
import { copilotChatRoute } from "./chat";
import { copilotIntentsRoute } from "./intents";
import { copilotUsageRoute } from "./usage";

export const copilotRoute = new Hono()
  .route("/credentials", copilotCredentialsRoute)
  .route("/threads", copilotThreadsRoute)
  .route("/chat", copilotChatRoute)
  .route("/intents", copilotIntentsRoute)
  .route("/usage", copilotUsageRoute);
