import { app } from "@azure/functions";
import { createHandlers } from "./handlers.js";

const handlers = createHandlers();

app.http("authLogin", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "auth/login",
  handler: handlers.login,
});

app.http("authSession", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "auth/session",
  handler: handlers.session,
});

app.http("authLogout", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "auth/logout",
  handler: handlers.logout,
});

app.http("speechToken", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "speech/token",
  handler: handlers.speechToken,
});

