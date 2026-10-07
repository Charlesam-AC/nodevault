/**
 * NodeVault Dynamic Font Scaling & Horizontal Layout Alignment Core
 * Author: Charles Amulike
 */
function synchronizeHorizontalMatrixLayout() {
  // STEP 1: FORCE UNIFORM HORIZONTAL LABELS (Bans vertical wrapping entirely)
  const columnHeaders = document.querySelectorAll('.ledger-th-text');
  columnHeaders.forEach(header => {
    const textLength = header.textContent.trim().length;
    if (textLength > 15) {
      // Handles long accounting phrases (e.g., "TOTAL RE-ISSUABLE")
      header.style.fontSize = "9.5px";
      header.style.letterSpacing = "-0.4px";
    } else if (textLength > 10) {
      header.style.fontSize = "11px";
    } else {
      header.style.fontSize = "12px";
    }
  });
  // STEP 2: AUTO-FITTING VALUES (As cell value increases, font size decreases dynamically)
  const activeValueCells = document.querySelectorAll('.dynamic-fit-value');
  activeValueCells.forEach(cell => {
    if (cell.classList.contains('col-grand')) {
      cell.style.fontSize = '14px';
      return;
    }
    const cashStringLength = cell.textContent.trim().length;
    // e.g., "K1,656,515.00"
    let optimalFontSize = 14;
    if (cashStringLength > 13) {
      optimalFontSize = 10;
    } else if (cashStringLength > 11) {
      optimalFontSize = 11.5;
    } else if (cashStringLength > 9) {
      optimalFontSize = 13;
    }
    cell.style.fontSize = `${optimalFontSize}px`;
  });
}
window.addEventListener('resize', synchronizeHorizontalMatrixLayout);
document.addEventListener('DOMContentLoaded', synchronizeHorizontalMatrixLayout);
