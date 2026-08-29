// ATS best practice: no spaces, no special characters, name + "Resume" +
// company/role somewhere in the filename. Recruiters and some ATS parsers
// use the filename itself as a weak signal, and a messy name like
// "Resume(3)_final_FINAL2.pdf" reads as sloppy.

function slug(value, fallback) {
  if (!value) return fallback;
  return String(value)
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "_");
}

// Accepts either an already-split { firstName, lastName } or a single
// { fullName } string (the candidate name extracted from the uploaded résumé).
// Any missing name part is filled from `fullName`; a missing first name falls
// back to "Candidate". Output: First[_Last]_Resume[_Company|_Role].pdf
export function buildFilename({ firstName, lastName, fullName, company, roleTitle }) {
  let first = firstName;
  let last = lastName;
  if ((!first || !last) && fullName) {
    const parts = String(fullName).trim().split(/\s+/).filter(Boolean);
    if (!first) first = parts[0];
    if (!last) last = parts.slice(1).join(" ");
  }

  first = slug(first, "Candidate");
  last = slug(last, "");
  const co = slug(company, "");
  const role = slug(roleTitle, "");

  const parts = [first];
  if (last) parts.push(last);
  parts.push("Resume");
  if (co) parts.push(co);
  else if (role) parts.push(role);

  return parts.join("_") + ".pdf";
}
