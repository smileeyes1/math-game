const fs = require("fs");
const path = require("path");

const files = ["public/index.html","public/teacher.html"];
for (const rel of files) {
  const full = path.join(__dirname, "..", rel);
  const html = fs.readFileSync(full, "utf8");
  const match = html.match(/<script>([\s\S]*?)<\/script>/i);
  if (!match) throw new Error(rel + ": no inline script found");
  new Function(match[1]);
  if (!html.includes("محمد غنام")) throw new Error(rel + ": teacher identity missing");
}
const student = fs.readFileSync(path.join(__dirname,"..","public/index.html"),"utf8");
if (!student.includes("/api/evidence")) throw new Error("student evidence API missing");
if (student.includes("speechSynthesis")) throw new Error("student must not depend on device synthetic speech");
if (!student.includes("restartLesson")) throw new Error("lesson replay is missing");
if (!student.includes("arcadeStage")) throw new Error("number 4 arcade reinforcement is missing");
if (!student.includes("لعبة حارس ٤")) throw new Error("professional game button label is missing");
if (!student.includes("guardian4-v1")) throw new Error("guardian 4 game version marker is missing");
if (!student.includes("showWorld1") || !student.includes("showWorld2") || !student.includes("showWorld3") || !student.includes("showBoss")) throw new Error("guardian 4 worlds are incomplete");
if (!student.includes("pro_game_complete")) throw new Error("professional game telemetry is missing");
const teacher = fs.readFileSync(path.join(__dirname,"..","public/teacher.html"),"utf8");
if (!teacher.includes("/api/teacher/sessions")) throw new Error("teacher sessions API missing");
if (!teacher.includes("EventSource")) throw new Error("near-real-time teacher stream missing");
console.log("HTML/JS checks passed");
