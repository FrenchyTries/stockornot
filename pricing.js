/* The button cannot take money yet, and pretending otherwise would collect
   card details for a thing that does not exist. It says so plainly instead.
   (A file rather than an inline script, so the page's Content-Security-Policy
   can refuse inline scripts outright.) */
const join = document.getElementById("join");
join.setAttribute("aria-disabled", "true");
join.textContent = "Opening soon";
join.addEventListener("click", (e) => { e.preventDefault(); location.href = "/"; });
