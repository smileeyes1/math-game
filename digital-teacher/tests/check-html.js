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
const teacher = fs.readFileSync(path.join(__dirname,"..","public/teacher.html"),"utf8");
if (!teacher.includes("/api/teacher/sessions")) throw new Error("teacher sessions API missing");
if (!teacher.includes("EventSource")) throw new Error("near-real-time teacher stream missing");
console.log("HTML/JS checks passed");
