const express = require("express");
const router = express.Router();
const { startOAuth, oauthCallback } = require("../controllers/authController");

router.get("/", startOAuth);
router.get("/callback", oauthCallback);

module.exports = router;
