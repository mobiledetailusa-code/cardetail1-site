const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

const tech = read('technician.html');
const techPhotos = read('netlify/functions/tech-job-photos.js');
const techComplete = read('netlify/functions/tech-complete-job.js');
const jobPhotoImage = read('netlify/functions/job-photo-image.js');
const storage = read('netlify/lib/job-photo-storage.js');

test('tech portal has in-app photo upload UI', () => {
  assert.match(tech, /tech-job-photos/);
  assert.match(tech, /onPhotoPick/);
  assert.match(tech, /grid-before/);
  assert.match(tech, /grid-after/);
  assert.doesNotMatch(tech, /Upload via admin review if not yet available/);
});

test('tech-job-photos validates phase and uses job photo store', () => {
  assert.match(techPhotos, /validateTechSession/);
  assert.match(techPhotos, /phase_must_be_before_or_after/);
  assert.match(techPhotos, /job-photo-storage/);
  assert.match(techPhotos, /photosBefore/);
});

test('tech-complete-job requires before and after photos', () => {
  assert.match(techComplete, /photos_before_required/);
  assert.match(techComplete, /photos_after_required/);
});

test('job photo serve endpoint uses strict id regex', () => {
  assert.match(jobPhotoImage, /jobph_/);
  assert.match(storage, /cd1-job-photos/);
  assert.match(storage, /MAX_BYTES/);
});
