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

import axios, { AxiosInstance } from 'axios';
import {
  ITokenResponse,
  IStatByTime,
  IStatByFloor,
  IServiceLevel,
} from './types';

/** Safety margin before token expiry (60 s). */
const TOKEN_REFRESH_MARGIN_MS = 60 * 1000;

export interface SchindlerClientOptions {
  baseUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
}

/**
 * HTTP client for the Schindler "People & Goods Data" REST API.
 *
 * Auth: OAuth2 client_credentials. The client_id / client_secret are posted
 * (form-urlencoded) to the token endpoint, which returns a JWT used as
 * `Authorization: Bearer <jwt>`. Token is cached and refreshed automatically.
 *
 * All calls are read-only (GET only).
 */
export class SchindlerClient {
  private readonly http: AxiosInstance;
  private accessToken: string | null = null;
  private tokenExpiresAt = 0; // epoch ms

  constructor(private readonly opts: SchindlerClientOptions) {
    this.http = axios.create({ baseURL: opts.baseUrl });
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  private async authenticate(): Promise<void> {
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', this.opts.clientId);
    params.append('client_secret', this.opts.clientSecret);
    if (this.opts.scope) params.append('scope', this.opts.scope);

    const res = await axios.post<ITokenResponse>(
      this.opts.tokenUrl,
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    this.accessToken = res.data.access_token;
    const lifetimeMs = (res.data.expires_in || 3600) * 1000;
    this.tokenExpiresAt = Date.now() + lifetimeMs - TOKEN_REFRESH_MARGIN_MS;
    console.log(
      '[token] Authenticated – expires in ~',
      Math.round((res.data.expires_in || 3600) / 60),
      'min'
    );
  }

  /** Refresh token if missing or expiring within the safety margin. */
  async ensureToken(): Promise<void> {
    if (!this.accessToken || Date.now() >= this.tokenExpiresAt) {
      await this.authenticate();
    }
  }

  private authHeaders() {
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  /** Execute fn; on 401 force a token refresh and retry once. */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err: any) {
      if (err?.response?.status === 401) {
        console.log('[token] 401 – forcing refresh and retrying');
        this.accessToken = null;
        await this.authenticate();
        return fn();
      }
      throw err;
    }
  }

  // ── API calls (read-only GET) ─────────────────────────────────────────────

  /** Passenger traffic statistics aggregated per time bucket. */
  async getStatisticsByTime(
    equipmentNumber: string,
    startTime: string,
    endTime: string,
    resolutionMinutes: number
  ): Promise<IStatByTime[]> {
    await this.ensureToken();
    return this.withRetry(() =>
      this.http
        .get<IStatByTime[]>(
          `/elevators/${encodeURIComponent(equipmentNumber)}/statisticsByTime`,
          {
            headers: this.authHeaders(),
            params: { startTime, endTime, resolution: resolutionMinutes },
          }
        )
        .then((r) => r.data || [])
    );
  }

  /** Passenger traffic statistics aggregated per floor over the period. */
  async getStatisticsByFloor(
    equipmentNumber: string,
    startTime: string,
    endTime: string,
    resolutionMinutes: number
  ): Promise<IStatByFloor[]> {
    await this.ensureToken();
    return this.withRetry(() =>
      this.http
        .get<IStatByFloor[]>(
          `/elevators/${encodeURIComponent(equipmentNumber)}/statisticsByFloor`,
          {
            headers: this.authHeaders(),
            params: { startTime, endTime, resolution: resolutionMinutes },
          }
        )
        .then((r) => r.data || [])
    );
  }

  /** Service-level distributions (waiting / destination time, intermediate stops). */
  async getStatisticsByServiceLevel(
    equipmentNumber: string,
    startTime: string,
    endTime: string,
    resolutionMinutes: number
  ): Promise<IServiceLevel> {
    await this.ensureToken();
    return this.withRetry(() =>
      this.http
        .get<IServiceLevel>(
          `/elevators/${encodeURIComponent(equipmentNumber)}/statisticsByServiceLevel`,
          {
            headers: this.authHeaders(),
            params: { startTime, endTime, resolution: resolutionMinutes },
          }
        )
        .then((r) => r.data)
    );
  }
}
