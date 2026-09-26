import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/admin/pages/PlaceEditorPage.tsx'],bundle:true,format:'esm',platform:'node',write:false });
const { parsePlaceEditorData } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
const location = (version) => ({ campusId:'campus_baoshan',buildingPlaceId:'building',floorId:null,role:'footprint',geometryType:'Polygon',geometry:null,crs:null,mapVersionId:version,mapFeatureId:`feature_${version}`,locationHint:null,precisionLevel:'exact',accuracyMeters:null,sourceId:null,validFrom:null,validTo:null,isPrimary:true });
function response(status, draftLocations = [location('old')], currentLocations = [location('new')]) {
  return { place:{ editorial_status:status,lifecycle_status:'active',display_name:'食堂',summary:null,description:null,source_id:null,
    structure_json:JSON.stringify({ aliases:[],building:null,kindId:'building',campusId:'campus_baoshan',parentPlaceId:null,stableCode:null,locations:draftLocations }),
    content_json:JSON.stringify({ detail:{ facts:[],media:[] } }) },locations:currentLocations,revisions:[],names:[],floors:[] };
}
test('editing approved content starts from migrated live locations', () => {
  const parsed = parsePlaceEditorData(response('approved'));
  assert.equal(parsed.revision.locations[0].mapVersionId,'new');
  assert.equal(parsed.revision.locations[0].mapFeatureId,'feature_new');
});
for (const status of ['draft','in_review']) {
  test(`${status} preserves intentional location edits and deletions`, () => {
    assert.equal(parsePlaceEditorData(response(status)).revision.locations[0].mapVersionId,'old');
    assert.deepEqual(parsePlaceEditorData(response(status,[])).revision.locations,[]);
  });
}
test('empty live locations never resurrect an approved historical binding', () => {
  assert.deepEqual(parsePlaceEditorData(response('approved',undefined,[])).revision.locations,[]);
});
