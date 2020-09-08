const geolib = require("geolib");
const turf = require("@turf/turf");
const geohash = require("ngeohash");

exports.getBoundsOfDistance = ({ latitude, longitude }, distance) => {
  const bounds = geolib.getBoundsOfDistance(
    { latitude, longitude },
    distance * 1000
  );

  return bounds;
};

exports.getGeohashRange = (bounds, distance) => {
  const lower = geohash.encode(bounds[0].latitude, bounds[0].longitude, 12);
  const upper = geohash.encode(bounds[1].latitude, bounds[1].longitude, 12);

  return {
    lower,
    upper,
  };
};

exports.getBoundingBox = (lower, upper) => {
  const line = turf.lineString([
    [lower.latitude, lower.longitude],
    [upper.latitude, upper.longitude],
  ]);
  const bbox = turf.bbox(line);
  const bboxPolygon = turf.bboxPolygon(bbox);

  let boundingBox = [];

  bboxPolygon.geometry.coordinates.map((coordinate) => {
    coordinate.map((latLng, index) => {
      if (index <= 3) {
        boundingBox.push({
          latitude: latLng[0],
          longitude: latLng[1],
        });
      }
    });
  });

  return boundingBox;
};

exports.isPointInBoundingBox = (coordinates, boundingBox) => {
  return geolib.isPointInPolygon(coordinates, boundingBox);
};
