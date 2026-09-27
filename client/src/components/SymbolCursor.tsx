import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import "./SymbolCursor.css";

// Edit these settings to customize the cursor and its trail.
const SYMBOL_CURSOR_SETTINGS = {
  symbols: ["~", ".", ",", "<", ">", "?", "-", "+", "×", "÷", "%", "s", ":", ";"],
  changeIntervalMs: 50,
  trailDurationMs: 450,
  fallDistancePx: 28,
  nativeCursorSelector: 'button, [role="button"], input, textarea, select, [role="slider"], [role="switch"], [role="textbox"], [contenteditable="true"], .theme-toggle, .game-card, .answer-choice',
};

export default function SymbolCursor() {
  const cursorRef = useRef<HTMLSpanElement>(null);
  const trailsRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const cursor = cursorRef.current;
    const trails = trailsRef.current;
    if (!cursor || !trails) return;

    const settings = SYMBOL_CURSOR_SETTINGS;
    const symbols = [...new Set(settings.symbols.filter(Boolean))];
    if (symbols.length === 0) symbols.push("~");
    const measurement = document.createElement("canvas").getContext("2d");
    if (!measurement) return;
    measurement.textAlign = "left";
    measurement.textBaseline = "alphabetic";
    // SVG getBBox can include font ascent/descent space. Canvas ink metrics
    // measure the symbol itself, including low punctuation such as a period.
    // Cache each centered SVG once for use by both cursor and trails.
    const glyphs = symbols.map((symbol) => {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.classList.add("symbol-cursor-glyph");
      svg.setAttribute("viewBox", "0 0 24 24");
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.textContent = symbol;
      svg.appendChild(text);
      trails.appendChild(svg);
      const font = getComputedStyle(text);
      measurement.font = `${font.fontWeight} ${font.fontSize} ${font.fontFamily}`;
      const bounds = measurement.measureText(symbol);
      text.setAttribute("x", String(12 + (bounds.actualBoundingBoxLeft - bounds.actualBoundingBoxRight) / 2));
      text.setAttribute("y", String(12 + (bounds.actualBoundingBoxAscent - bounds.actualBoundingBoxDescent) / 2));
      svg.remove();
      return svg;
    });
    const mouseAvailable = window.matchMedia("(any-hover: hover) and (any-pointer: fine)");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let current = Math.floor(Math.random() * symbols.length);
    let lastChange = 0;
    let x = 0;
    let y = 0;
    let visible = false;
    let frame = 0;
    cursor.replaceChildren(glyphs[current].cloneNode(true));

    const hide = () => {
      visible = false;
      cursor.hidden = true;
      document.documentElement.classList.remove("symbol-cursor-active");
      trails.replaceChildren();
      cancelAnimationFrame(frame);
      frame = 0;
    };

    const paint = () => {
      if (document.documentElement.hasAttribute("data-native-cursor")) {
        hide();
        return;
      }
      cursor.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      cursor.hidden = false;
      document.documentElement.classList.add("symbol-cursor-active");
      frame = 0;
    };

    const dropSymbol = () => {
      if (reducedMotion.matches) return;
      const trail = document.createElement("span");
      trail.className = "symbol-cursor-trail";
      trail.appendChild(glyphs[current].cloneNode(true));
      trail.style.left = `${x}px`;
      trail.style.top = `${y}px`;
      trail.style.setProperty("--fall-distance", `${settings.fallDistancePx}px`);
      trail.style.setProperty("--drift", `${(Math.random() - 0.5) * 20}px`);
      trail.style.setProperty("--rotation", `${(Math.random() - 0.5) * 40}deg`);
      trail.style.animationDuration = `${settings.trailDurationMs}ms`;
      trail.addEventListener("animationend", () => trail.remove(), { once: true });
      // Keep the trail bounded even if animations are paused by the browser.
      if (trails.childElementCount >= 24) trails.firstElementChild?.remove();
      trails.appendChild(trail);
    };

    const move = (event: PointerEvent) => {
      if (
        event.pointerType !== "mouse"
        || !mouseAvailable.matches
        || document.documentElement.hasAttribute("data-native-cursor")
        || (event.target instanceof Element
          && event.target.closest(settings.nativeCursorSelector) !== null)
      ) {
        hide();
        return;
      }
      const now = performance.now();
      if (visible && event.clientX === x && event.clientY === y) return;
      if (!visible) {
        visible = true;
        lastChange = now;
      } else if (now - lastChange >= settings.changeIntervalMs) {
        dropSymbol();
        if (symbols.length > 1) {
          // Choose another symbol without repeating the current one.
          current = (current + 1 + Math.floor(Math.random() * (symbols.length - 1))) % symbols.length;
        }
        cursor.replaceChildren(glyphs[current].cloneNode(true));
        lastChange = now;
      }
      x = event.clientX;
      y = event.clientY;
      if (!frame) frame = requestAnimationFrame(paint);
    };

    const leave = (event: PointerEvent) => {
      if (event.relatedTarget === null) hide();
    };
    const visibilityChange = () => {
      if (document.hidden) hide();
    };

    // Clear the custom cursor immediately when a modal/game opens, even if
    // the mouse is stationary. Movement restores it after returning to the lobby.
    const cursorModeObserver = new MutationObserver(() => {
      if (document.documentElement.hasAttribute("data-native-cursor")) hide();
    });
    cursorModeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-native-cursor"],
    });

    window.addEventListener("pointermove", move, { capture: true, passive: true });
    window.addEventListener("pointerover", move, { capture: true, passive: true });
    window.addEventListener("pointerout", leave);
    window.addEventListener("blur", hide);
    document.addEventListener("visibilitychange", visibilityChange);
    mouseAvailable.addEventListener("change", hide);
    return () => {
      cursorModeObserver.disconnect();
      hide();
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerover", move, true);
      window.removeEventListener("pointerout", leave);
      window.removeEventListener("blur", hide);
      document.removeEventListener("visibilitychange", visibilityChange);
      mouseAvailable.removeEventListener("change", hide);
    };
  }, []);

  return createPortal(
    <div className="symbol-cursor-layer" aria-hidden="true">
      <span ref={trailsRef} />
      <span ref={cursorRef} className="symbol-cursor" hidden />
    </div>,
    document.body,
  );
}
