"use strict";

const chat = require("./aiProxy/index.js");
const image = require("./generateImage/index.js");

exports.main = async (event, context) => {
  switch (event?.action) {
    case "ping":
      return { ...await chat.main(event, context), capabilities: { generateImage: true } };
    case "checkImage":
      return image.main({ action: "check", prompt: event.prompt });
    case "generateImage":
      return image.main({ prompt: event.prompt });
    default:
      return chat.main(event, context);
  }
};
