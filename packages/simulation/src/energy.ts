export function batteryPercentageForDistance(distanceMeters: number, capacityKwh: number, consumptionKwhPerKm: number): number {
  if (distanceMeters < 0 || capacityKwh <= 0 || consumptionKwhPerKm < 0) throw new RangeError("Invalid energy calculation input");
  return (distanceMeters / 1_000 * consumptionKwhPerKm) / capacityKwh * 100;
}
