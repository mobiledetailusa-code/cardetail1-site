/* Shared package detail data + in-page modal (homepage + state hubs) */
const CAR_PKG_DETAILS = {
  interior: {
    title: "Interior Detail",
    includes: [
      "Deep vacuum — seats, floors, trunk, and truck bed where applicable",
      "Fabric seats & carpet shampoo",
      "Leather surfaces conditioned",
      "Steam clean — vents, panels, crevices",
      "Dashboard, doors & trim detail with UV protectant on plastics",
      "Interior glass cleaned",
      "Door jambs cleaned",
      "Headliner cleaning",
    ],
    bestFor: [
      "Daily drivers",
      "Family cars",
      "Dust, spills, and normal interior buildup",
    ],
    addonsMayApply: [
      "Heavy pet hair",
      "Severe odor",
      "Mold",
      "Biohazard",
      "Excessive stains",
    ],
  },
  full: {
    title: "Premium Full Detail",
    includes: [
      "Deep vacuum — seats, floors, trunk, and truck bed where applicable",
      "Fabric seats & carpet shampoo",
      "Leather surfaces conditioned",
      "Steam clean — vents, panels, crevices",
      "Dashboard, doors & trim detail with UV protectant on plastics",
      "Interior glass cleaned",
      "Door jambs cleaned",
      "Headliner cleaning",
      "Exterior hand wash",
      "Wheels and tires",
      "Exterior glass",
      "Light paint cleaning",
      "Exterior protection",
    ],
    bestFor: [
      "Full refresh inside and out",
      "Seasonal cleanup",
      "Resale prep",
      "Neglected daily drivers",
    ],
    addonsMayApply: [
      "Heavy pet hair",
      "Odor",
      "Deep stains",
      "Clay/polish upgrade",
      "Engine bay",
      "Headlights",
    ],
  },
  refresh: {
    title: "Exterior Detail & Paint Enhancement",
    includes: [
      "Hand wash",
      "Wheels and tires",
      "Exterior glass",
      "Clay bar/decontamination",
      "Polish or gloss enhancement",
      "Sealant/protection",
    ],
    bestFor: [
      "Dull paint",
      "Road film",
      "Brake dust",
      "Loss of gloss",
      "Exterior restoration",
    ],
    addonsMayApply: [
      "Heavy oxidation",
      "Severe scratches",
      "Ceramic coating",
      "Engine bay",
      "Headlight restoration",
    ],
  },
};

function buildCarPkgDetailSectionsHtml(d) {
  if (!d) return "";
  let html = "";
  if (d.includes && d.includes.length) {
    html += `<div class="car-pkg-detail-section"><h4>Includes</h4><ul class="car-pkg-detail-list car-pkg-detail-list--inc">${d.includes.map((i) => `<li>${i}</li>`).join("")}</ul></div>`;
  }
  if (d.bestFor) {
    if (Array.isArray(d.bestFor)) {
      html += `<div class="car-pkg-detail-section"><h4>Best for</h4><ul class="car-pkg-detail-list car-pkg-detail-list--inc">${d.bestFor.map((i) => `<li>${i}</li>`).join("")}</ul></div>`;
    } else {
      html += `<div class="car-pkg-detail-section"><h4>Best for</h4><p>${d.bestFor}</p></div>`;
    }
  }
  if (d.addonsMayApply && d.addonsMayApply.length) {
    html += `<div class="car-pkg-detail-section"><h4>Add-ons may apply</h4><ul class="car-pkg-detail-list car-pkg-detail-list--addons">${d.addonsMayApply.map((i) => `<li>${i}</li>`).join("")}</ul></div>`;
  }
  return html;
}

function getHomePkgPriceNote(pkgId) {
  if (pkgId === "full") {
    const note = document.getElementById("home-from-full-note");
    return note ? note.textContent.trim() : "";
  }
  const amt = document.getElementById("home-from-" + pkgId);
  const note = document.getElementById("home-from-" + pkgId + "-note");
  if (amt && note) return "From " + amt.textContent.trim() + " · " + note.textContent.trim();
  if (amt) return "From " + amt.textContent.trim();
  return "";
}

function openHomePkgDetailModal(pkgId, e) {
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }
  const d = CAR_PKG_DETAILS[pkgId];
  const ov = document.getElementById("car-pkg-detail-ov");
  if (!d || !ov) return;
  const titleEl = document.getElementById("car-pkg-detail-title");
  const priceEl = document.getElementById("car-pkg-detail-price");
  const bodyEl = document.getElementById("car-pkg-detail-body");
  const bookBtn = document.getElementById("car-pkg-detail-book");
  if (!titleEl || !priceEl || !bodyEl || !bookBtn) return;
  titleEl.textContent = d.title;
  priceEl.textContent = getHomePkgPriceNote(pkgId);
  bodyEl.innerHTML = buildCarPkgDetailSectionsHtml(d);
  bookBtn.onclick = function () {
    closeHomePkgDetailModal();
    if (typeof openBookingCarPkg === "function") openBookingCarPkg(pkgId);
  };
  ov.hidden = false;
  ov.removeAttribute("aria-hidden");
  document.body.style.overflow = "hidden";
  requestAnimationFrame(function () {
    try {
      ov.querySelector(".car-pkg-detail-close").focus();
    } catch (_) {}
  });
}

function closeHomePkgDetailModal() {
  const ov = document.getElementById("car-pkg-detail-ov");
  if (!ov || ov.hidden) return;
  ov.hidden = true;
  ov.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

function initCarPkgDetailModal() {
  const ov = document.getElementById("car-pkg-detail-ov");
  if (!ov) return;
  ov.hidden = true;
  ov.setAttribute("aria-hidden", "true");
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !ov.hidden) closeHomePkgDetailModal();
  });
}
