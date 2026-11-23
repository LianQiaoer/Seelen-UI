const ctx = canvas.getContext("2d");
const color = (typeof themeTokens !== "undefined" && themeTokens && themeTokens.foregroundColor) || "#ffffff";

ctx.clearRect(0, 0, canvas.width, canvas.height);
ctx.fillStyle = color;

const size = canvas.width;
const margin = size * 0.14;
const gap = size * 0.07;
const cell = (size - margin * 2 - gap * 2) / 3;
const radius = cell * 0.28;

function cellRect(x, y, w, h, r) {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.rect(x, y, w, h);
  }
  ctx.fill();
}

for (let row = 0; row < 3; row++) {
  for (let col = 0; col < 3; col++) {
    const x = margin + col * (cell + gap);
    const y = margin + row * (cell + gap);
    cellRect(x, y, cell, cell, radius);
  }
}
