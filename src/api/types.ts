/*
 * Copyright 2024 SpinalCom - www.spinalcom.com
 *
 * This file is part of SpinalCore.
 *
 * Please read all of the following terms and conditions
 * of the Free Software license Agreement ("Agreement")
 * carefully.
 *
 * This Agreement is a legally binding contract between
 * the Licensee (as defined below) and SpinalCom that
 * sets forth the terms and conditions that govern your
 * use of the Program. By installing and/or using the
 * Program, you agree to abide by all the terms and
 * conditions stated or referenced herein.
 *
 * If you do not agree to abide by these terms and
 * conditions, do not demonstrate your acceptance and do
 * not install or use the Program.
 * You should have received a copy of the license along
 * with this file. If not, see
 * <http://resources.spinalcom.com/licenses.pdf>.
 */

// ── OAuth2 ───────────────────────────────────────────────────────────────────

export interface ITokenResponse {
  access_token: string;
  token_type: string;
  /** Lifetime in seconds. */
  expires_in: number;
}

// ── statisticsByTime (returns an array, one item per time bucket) ─────────────

export interface IStatByTime {
  /** ISO timestamp marking the start of the bucket, e.g. "2022-05-16T12:00:00". */
  startTime: string;
  passengerCount: number;
  averageWaitingTime: number;
  averageDestinationTime: number;
  averageNumberOfIntermediateStops: number;
  percentageOfLongWaits: number;
}

// ── statisticsByFloor (returns an array, one item per floor) ──────────────────

export interface IStatByFloor {
  floorNumber: number;
  passengerCount: number;
  averageWaitingTime: number;
  averageDestinationTime: number;
  averageNumberOfIntermediateStops: number;
  percentageOfLongWaits: number;
  entranceSide?: string;
}

// ── statisticsByServiceLevel (returns an object of distribution buckets) ──────

export interface IServiceLevelRangeBucket {
  valuesFrom: number;
  valuesTo: number;
  percentage: number;
  passengerCount: number;
}

export interface IServiceLevelValueBucket {
  value: number;
  percentage: number;
  passengerCount: number;
}

export interface IServiceLevel {
  waitingTime: IServiceLevelRangeBucket[];
  destinationTime: IServiceLevelRangeBucket[];
  numberOfIntermediateStops: IServiceLevelValueBucket[];
}

/** Metrics shared by statisticsByTime and statisticsByFloor. */
export const TRAFFIC_METRICS: Array<keyof IStatByTime & keyof IStatByFloor> = [
  'passengerCount',
  'averageWaitingTime',
  'averageDestinationTime',
  'averageNumberOfIntermediateStops',
  'percentageOfLongWaits',
];
