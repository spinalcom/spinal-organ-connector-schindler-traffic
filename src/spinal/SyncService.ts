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

import { resolve as pathResolve } from 'path';
import {
  SpinalGraph,
  SpinalGraphService,
  SpinalNode,
  SpinalContext,
} from 'spinal-env-viewer-graph-service';
import { NetworkService } from 'spinal-model-bmsnetwork';
import { attributeService } from 'spinal-env-viewer-plugin-documentation-service';

import { SpinalConnector } from './SpinalConnector';
import { OrganConfigModel } from '../model/OrganConfigModel';
import { InputDataDevice } from '../model/InputDataDevice';
import { InputDataEndpointGroup } from '../model/InputDataEndpointGroup';
import {
  InputDataEndpoint,
  InputDataEndpointDataType,
  InputDataEndpointType,
} from '../model/InputDataEndpoint';
import { SchindlerClient } from '../api/SchindlerClient';
import { IServiceLevel, TRAFFIC_METRICS } from '../api/types';

const configJson = require('../../config');

// ── Graph relation names ──────────────────────────────────────────────────────
const REL_CATEGORY = 'hasCategory';      // Context  → Category
const REL_GROUP = 'hasGroup';            // Category → Group
const REL_BIMOBJECT = 'groupHasBIMObject'; // Group  → BIMObject
const REL_BMS_DEVICE = 'hasBmsDevice';
const REL_BMS_ENDPOINTGROUP = 'hasBmsEndpointGroup';
const REL_BMS_ENDPOINT = 'hasBmsEndpoint';

const FLOORS_GROUP_NAME = 'floors';
const MS_PER_MINUTE = 60 * 1000;
const MAX_WINDOW_DAYS = 31; // Schindler API: at most 31 days per request

// ── Runtime cache ─────────────────────────────────────────────────────────────

interface ElevatorCache {
  node: SpinalNode<any>;
  equipmentNumber: string;
  /** Device-level statisticsByTime endpoints: metric → endpoint node. */
  timeEndpoints: Map<string, SpinalNode<any>>;
  /** Device-level statisticsByServiceLevel endpoints: name → endpoint node. */
  serviceEndpoints: Map<string, SpinalNode<any>>;
  /** "floors" endpoint group node. */
  floorsGroup: SpinalNode<any>;
  /** Per-floor sub-nodes under the "floors" group: floorNumber → node. */
  floorNodes: Map<number, SpinalNode<any>>;
  /** Per-floor endpoints: "floor_13_passengerCount" → endpoint node. */
  floorEndpoints: Map<string, SpinalNode<any>>;
}

// ── SyncService ───────────────────────────────────────────────────────────────

/**
 * Mirrors Schindler elevator traffic statistics into the Spinal BOS.
 *
 * Structure created under the Virtual Network (one device per elevator):
 *   <equipmentNumber> (BmsDevice)
 *     ├── statisticsByTime endpoints (passengerCount, averageWaitingTime, …)
 *     ├── statisticsByServiceLevel endpoints (waitingTime_0_30_percentage, …)
 *     └── floors (BmsEndpointGroup)
 *           └── floor_<n> (BmsEndpointGroup)
 *                 └── floor_<n>_<metric> endpoints
 *
 * Structural nodes (device, floors group, per-floor groups) are attached with
 * addChildInContext; endpoints are attached with addChildInContext as well
 * (createNewBmsEndpoint).
 *
 * Time-series are injected with an explicit per-bucket timestamp so that a
 * configurable history can be backfilled on first start.
 */
export class SyncService {
  private graph!: SpinalGraph<any>;
  private config!: OrganConfigModel;
  private nwService: NetworkService;
  private nwContext!: SpinalContext<any>;
  private nwVirtual!: SpinalNode<any>;

  private readonly client: SchindlerClient;
  private running = false;

  private resolutionMin = 60;
  private resolutionMs = 60 * MS_PER_MINUTE;
  private historyMs = 1440 * MS_PER_MINUTE;

  private elevators = new Map<string, ElevatorCache>(); // equipmentNumber → cache

  constructor() {
    this.nwService = new NetworkService(true);
    this.client = new SchindlerClient({
      baseUrl: process.env.SCHINDLER_BASE_URL!,
      tokenUrl: process.env.SCHINDLER_TOKEN_URL!,
      clientId: process.env.SCHINDLER_CLIENT_ID!,
      clientSecret: process.env.SCHINDLER_CLIENT_SECRET!,
      scope: process.env.SCHINDLER_SCOPE || undefined,
    });
  }

  // ── Public interface ──────────────────────────────────────────────────────

  async init(): Promise<void> {
    await this.boot();

    this.resolutionMin = this.validateResolution(this.config.resolution.get() as number);
    this.resolutionMs = this.resolutionMin * MS_PER_MINUTE;
    this.historyMs = (this.config.historyDuration.get() as number) * MS_PER_MINUTE;

    await this.loadExistingElevators();
    const equipmentNumbers = await this.discoverElevators();
    for (const equip of equipmentNumbers) {
      await this.ensureElevatorDevice(equip);
    }
    console.log(`[init] ${this.elevators.size} elevator device(s) ready`);

    await this.client.ensureToken();
    await this.tick(); // first backfill / catch-up
    console.log('[init] Complete');
  }

  async run(): Promise<void> {
    this.running = true;
    const interval = this.config.pullInterval.get() as number;
    console.log(`[run] Loop started – interval ${interval} ms`);

    while (this.running) {
      const tickStart = Date.now();
      try {
        await this.client.ensureToken();
        await this.tick();
      } catch (err: any) {
        if (!err?.response) {
          console.error('[run] Network error – backing off 60 s:', err?.message ?? err);
          await this.sleep(60000);
          continue;
        }
        console.error('[run] Tick error:', err?.response?.status, err?.message ?? err);
      }
      const elapsed = Date.now() - tickStart;
      await this.sleep(Math.max(0, interval - elapsed));
    }
    console.log('[run] Loop stopped');
  }

  stop(): void {
    this.running = false;
  }

  // ── Boot ──────────────────────────────────────────────────────────────────

  private async boot(): Promise<void> {
    const connector = SpinalConnector.getInstance();
    const loadPath = pathResolve(configJson.organ.configPath, configJson.organ.name);
    try {
      this.config = await connector.load<OrganConfigModel>(loadPath);
      console.log('[init] Config loaded from hub');
    } catch {
      console.log('[init] Config not found – creating');
      this.config = new OrganConfigModel();
      this.config.initEnv();
      await connector.store(loadPath, this.config);
    }
    this.config.bindRestart();

    console.log('[init] Loading graph from', this.config.digitalTwinPath.get());
    this.graph = await connector.load<SpinalGraph<any>>(this.config.digitalTwinPath.get());
    console.log('[init] Graph loaded');

    await this.nwService.init(this.graph, {
      contextName: process.env.NETWORK_NAME!,
      contextType: 'Network',
      networkName: process.env.VIRTUAL_NETWORK_NAME!,
      networkType: 'NetworkVirtual',
    });

    this.nwContext = await this.resolveContextByName(process.env.NETWORK_NAME!);
    const contextChildren = await this.nwContext.getChildrenInContext();
    const virtualNode = contextChildren.find(
      (n) => n.getName().get() === process.env.VIRTUAL_NETWORK_NAME!
    );
    if (!virtualNode) {
      throw new Error(`[init] Virtual network '${process.env.VIRTUAL_NETWORK_NAME}' not found`);
    }
    this.nwVirtual = virtualNode;
    SpinalGraphService._addNode(this.nwVirtual);
    console.log('[init] Network nodes resolved');
  }

  // ── Elevator discovery (BOS graph navigation) ─────────────────────────────

  /**
   * Walk Context → Category → Group → BIMObjects and read the configured
   * attribute on each BIMObject to collect Schindler equipmentNumbers.
   */
  private async discoverElevators(): Promise<string[]> {
    const contextName = process.env.BOS_CONTEXT_NAME;
    const categoryName = process.env.BOS_CATEGORY_NAME;
    const groupName = process.env.BOS_GROUP_NAME;
    const attrCategory = process.env.EQUIPMENT_ATTR_CATEGORY;
    const attrName = process.env.EQUIPMENT_ATTR_NAME;

    if (!contextName || !categoryName || !groupName || !attrCategory || !attrName) {
      console.warn(
        '[discover] BOS navigation env vars are incomplete – no elevator discovered'
      );
      return [];
    }

    let context: SpinalContext<any>;
    try {
      context = await this.resolveContextByName(contextName);
    } catch {
      console.warn(`[discover] Context '${contextName}' not found`);
      return [];
    }

    const category = await this.findChildByName(context, REL_CATEGORY, categoryName);
    if (!category) {
      console.warn(`[discover] Category '${categoryName}' not found in '${contextName}'`);
      return [];
    }

    const group = await this.findChildByName(category, REL_GROUP, groupName);
    if (!group) {
      console.warn(`[discover] Group '${groupName}' not found in '${categoryName}'`);
      return [];
    }

    const bimObjects = await group.getChildren([REL_BIMOBJECT]);
    const equipmentNumbers: string[] = [];
    const seen = new Set<string>();

    for (const bim of bimObjects) {
      try {
        const attr = await attributeService.findOneAttributeInCategory(
          bim,
          attrCategory,
          attrName
        );
        if (attr === -1 || attr === undefined || attr === null) continue;
        const value = String((attr as any).value.get()).trim();
        if (!value || seen.has(value)) continue;
        seen.add(value);
        equipmentNumbers.push(value);
      } catch (err: any) {
        console.warn(
          `[discover] Cannot read attribute on '${bim.getName().get()}':`,
          err?.message ?? err
        );
      }
    }

    console.log(`[discover] ${equipmentNumbers.length} equipmentNumber(s) found:`, equipmentNumbers);
    return equipmentNumbers;
  }

  // ── Load existing devices from BOS (idempotent restart) ───────────────────

  private async loadExistingElevators(): Promise<void> {
    const devices = await this.nwVirtual.getChildrenInContext(this.nwContext);
    for (const device of devices) {
      const equip = device.getName().get();
      SpinalGraphService._addNode(device);

      const timeEndpoints = new Map<string, SpinalNode<any>>();
      const serviceEndpoints = new Map<string, SpinalNode<any>>();
      const deviceEps = await device.getChildren([REL_BMS_ENDPOINT]);
      for (const ep of deviceEps) {
        const name = ep.getName().get();
        SpinalGraphService._addNode(ep);
        if (TRAFFIC_METRICS.indexOf(name as any) !== -1) timeEndpoints.set(name, ep);
        else serviceEndpoints.set(name, ep);
      }

      const floorNodes = new Map<number, SpinalNode<any>>();
      const floorEndpoints = new Map<string, SpinalNode<any>>();
      let floorsGroup = await this.findChildByName(
        device,
        REL_BMS_ENDPOINTGROUP,
        FLOORS_GROUP_NAME
      );
      if (!floorsGroup) {
        floorsGroup = await this.createEndpointGroup(device, FLOORS_GROUP_NAME);
      } else {
        // Each child of "floors" is a per-floor sub-group holding its endpoints.
        const floorChildren = await floorsGroup.getChildren([REL_BMS_ENDPOINTGROUP]);
        for (const floorNode of floorChildren) {
          SpinalGraphService._addNode(floorNode);
          const n = this.parseFloorNumber(floorNode.getName().get());
          if (n !== null) floorNodes.set(n, floorNode);
          const floorEps = await floorNode.getChildren([REL_BMS_ENDPOINT]);
          for (const ep of floorEps) {
            SpinalGraphService._addNode(ep);
            floorEndpoints.set(ep.getName().get(), ep);
          }
        }
      }

      this.elevators.set(equip, {
        node: device,
        equipmentNumber: equip,
        timeEndpoints,
        serviceEndpoints,
        floorsGroup,
        floorNodes,
        floorEndpoints,
      });
    }
    console.log(`[init] ${this.elevators.size} existing elevator device(s) loaded from BOS`);
  }

  // ── Device / endpoint creation ────────────────────────────────────────────

  private async ensureElevatorDevice(equip: string): Promise<ElevatorCache> {
    const existing = this.elevators.get(equip);
    if (existing) return existing;

    console.log(`[spinal] Creating elevator device: ${equip}`);
    const node = await this.createDevice(this.nwVirtual, equip, 'elevator');

    await attributeService.createOrUpdateAttrsAndCategories(node, 'Schindler', {
      equipmentNumber: equip,
      lastSync: new Date().toISOString(),
    });

    const timeEndpoints = new Map<string, SpinalNode<any>>();
    for (const metric of TRAFFIC_METRICS) {
      timeEndpoints.set(metric, await this.createEndpoint(node, metric));
    }

    const floorsGroup = await this.createEndpointGroup(node, FLOORS_GROUP_NAME);

    const cache: ElevatorCache = {
      node,
      equipmentNumber: equip,
      timeEndpoints,
      serviceEndpoints: new Map(),
      floorsGroup,
      floorNodes: new Map(),
      floorEndpoints: new Map(),
    };
    this.elevators.set(equip, cache);
    return cache;
  }

  /**
   * Ensure the per-floor sub-group (floor_<n>) exists under "floors" and holds
   * its metric endpoints (floor_<n>_<metric>). The floor sub-group is attached
   * with addChildInContext; its endpoints with addChild.
   */
  private async ensureFloorEndpoints(cache: ElevatorCache, floorNumber: number): Promise<void> {
    let floorNode = cache.floorNodes.get(floorNumber);
    if (!floorNode) {
      floorNode = await this.createEndpointGroup(cache.floorsGroup, `floor_${floorNumber}`);
      cache.floorNodes.set(floorNumber, floorNode);
    }
    for (const metric of TRAFFIC_METRICS) {
      const name = `floor_${floorNumber}_${metric}`;
      if (!cache.floorEndpoints.has(name)) {
        cache.floorEndpoints.set(name, await this.createEndpoint(floorNode, name));
      }
    }
  }

  private async ensureServiceEndpoint(cache: ElevatorCache, name: string): Promise<SpinalNode<any>> {
    let ep = cache.serviceEndpoints.get(name);
    if (!ep) {
      ep = await this.createEndpoint(cache.node, name);
      cache.serviceEndpoints.set(name, ep);
    }
    return ep;
  }

  // ── Sync tick ──────────────────────────────────────────────────────────────

  /**
   * One synchronisation pass: brings every elevator from the persisted cursor
   * (or `now - history` on first start) up to the latest closed bucket.
   */
  private async tick(): Promise<void> {
    const now = Date.now();
    const end = this.alignDown(now);
    const cursor = this.config.cursor.get() as number;
    const start = cursor > 0 ? this.alignDown(cursor) : this.alignDown(now - this.historyMs);

    if (start >= end) return; // no fully-closed bucket since last sync

    const phase = cursor > 0 ? 'sync' : 'backfill';
    console.log(
      `[${phase}] ${new Date(start).toISOString()} → ${new Date(end).toISOString()} ` +
        `(resolution ${this.resolutionMin} min)`
    );

    for (const cache of this.elevators.values()) {
      try {
        await this.syncByTime(cache, start, end);
        await this.syncSliceViews(cache, start, end);
      } catch (err: any) {
        console.error(
          `[${phase}] Elevator ${cache.equipmentNumber} failed:`,
          err?.response?.status ?? '',
          err?.message ?? err
        );
      }
    }

    this.config.setCursor(end);
    this.config.updateSync();
    console.log(`[${phase}] Cursor advanced to ${new Date(end).toISOString()}`);
  }

  /** statisticsByTime: one request per ≤31-day window, dated injection per bucket. */
  private async syncByTime(cache: ElevatorCache, start: number, end: number): Promise<void> {
    const windowMs = this.windowMs();
    for (let s = start; s < end; s += windowMs) {
      const e = Math.min(end, s + windowMs);
      const data = await this.client.getStatisticsByTime(
        cache.equipmentNumber,
        this.fmt(s),
        this.fmt(e),
        this.resolutionMin
      );
      for (const item of data) {
        const ts = this.parseTs(item.startTime);
        if (ts === null) continue;
        for (const metric of TRAFFIC_METRICS) {
          await this.setEp(cache.timeEndpoints.get(metric), (item as any)[metric], ts);
        }
      }
    }
  }

  /**
   * statisticsByFloor & statisticsByServiceLevel aggregate the whole requested
   * period, so they are queried slice by slice to build a proper time-series.
   */
  private async syncSliceViews(cache: ElevatorCache, start: number, end: number): Promise<void> {
    for (let ti = start; ti < end; ti += this.resolutionMs) {
      const te = ti + this.resolutionMs;

      try {
        const floors = await this.client.getStatisticsByFloor(
          cache.equipmentNumber,
          this.fmt(ti),
          this.fmt(te),
          this.resolutionMin
        );
        for (const f of floors) {
          await this.ensureFloorEndpoints(cache, f.floorNumber);
          for (const metric of TRAFFIC_METRICS) {
            await this.setEp(
              cache.floorEndpoints.get(`floor_${f.floorNumber}_${metric}`),
              (f as any)[metric],
              ti
            );
          }
          if (f.entranceSide) {
            const floorNode = cache.floorNodes.get(f.floorNumber);
            if (floorNode) {
              await attributeService.createOrUpdateAttrsAndCategories(
                floorNode,
                'Floor',
                { entranceSide: String(f.entranceSide) }
              );
            }
          }
        }
      } catch (err: any) {
        console.error(
          `[sync] statisticsByFloor ${cache.equipmentNumber} @${this.fmt(ti)}:`,
          err?.response?.status ?? '',
          err?.message ?? err
        );
      }

      try {
        const sl = await this.client.getStatisticsByServiceLevel(
          cache.equipmentNumber,
          this.fmt(ti),
          this.fmt(te),
          this.resolutionMin
        );
        if (sl) await this.storeServiceLevel(cache, sl, ti);
      } catch (err: any) {
        console.error(
          `[sync] statisticsByServiceLevel ${cache.equipmentNumber} @${this.fmt(ti)}:`,
          err?.response?.status ?? '',
          err?.message ?? err
        );
      }
    }
  }

  private async storeServiceLevel(
    cache: ElevatorCache,
    sl: IServiceLevel,
    ti: number
  ): Promise<void> {
    for (const b of sl.waitingTime || []) {
      const base = `waitingTime_${b.valuesFrom}_${b.valuesTo}`;
      await this.setEp(await this.ensureServiceEndpoint(cache, `${base}_percentage`), b.percentage, ti);
      await this.setEp(await this.ensureServiceEndpoint(cache, `${base}_count`), b.passengerCount, ti);
    }
    for (const b of sl.destinationTime || []) {
      const base = `destinationTime_${b.valuesFrom}_${b.valuesTo}`;
      await this.setEp(await this.ensureServiceEndpoint(cache, `${base}_percentage`), b.percentage, ti);
      await this.setEp(await this.ensureServiceEndpoint(cache, `${base}_count`), b.passengerCount, ti);
    }
    for (const b of sl.numberOfIntermediateStops || []) {
      const base = `stops_${b.value}`;
      await this.setEp(await this.ensureServiceEndpoint(cache, `${base}_percentage`), b.percentage, ti);
      await this.setEp(await this.ensureServiceEndpoint(cache, `${base}_count`), b.passengerCount, ti);
    }
  }

  // ── BOS helpers ───────────────────────────────────────────────────────────

  private async createDevice(
    parent: SpinalNode<any>,
    name: string,
    type: string
  ): Promise<SpinalNode<any>> {
    const model = new InputDataDevice(name, type);
    const ref = await this.nwService.createNewBmsDevice(parent.getId().get(), model);
    return SpinalGraphService.getRealNode(ref.id.get());
  }

  private async createEndpointGroup(
    parent: SpinalNode<any>,
    name: string
  ): Promise<SpinalNode<any>> {
    const model = new InputDataEndpointGroup(name, name);
    const ref = await this.nwService.createNewBmsEndpointGroup(parent.getId().get(), model);
    return SpinalGraphService.getRealNode(ref.id.get());
  }

  private async createEndpoint(
    parent: SpinalNode<any>,
    name: string,
    initialValue: number | string = 0,
    unit = ''
  ): Promise<SpinalNode<any>> {
    const model = new InputDataEndpoint(
      name,
      initialValue,
      unit,
      InputDataEndpointDataType.Real,
      InputDataEndpointType.Other
    );
    const ref = await this.nwService.createNewBmsEndpoint(parent.getId().get(), model);
    return SpinalGraphService.getRealNode(ref.id.get());
  }

  /** Set an endpoint value at an explicit timestamp (dated time-series injection). */
  private async setEp(
    ep: SpinalNode<any> | undefined,
    value: number | undefined | null,
    dateMs: number
  ): Promise<void> {
    if (!ep) return;
    if (value === undefined || value === null || isNaN(value)) return;
    SpinalGraphService._addNode(ep);
    await this.nwService.setEndpointValue(ep.getId().get(), value, dateMs);
  }

  private async findChildByName(
    parent: SpinalNode<any>,
    relationName: string,
    name: string
  ): Promise<SpinalNode<any> | null> {
    const children = await parent.getChildren([relationName]);
    for (const child of children) {
      if (child.getName().get() === name) {
        SpinalGraphService._addNode(child);
        return child;
      }
    }
    return null;
  }

  private async resolveContextByName(name: string): Promise<SpinalContext<any>> {
    const children = await this.graph.getChildren();
    for (const ctx of children) {
      if (ctx.info.name.get() === name) {
        SpinalGraphService._addNode(ctx);
        return ctx as SpinalContext<any>;
      }
    }
    throw new Error(`[init] Context '${name}' not found in graph`);
  }

  // ── Time helpers ────────────────────────────────────────────────────────────

  /** Floor an epoch (ms) down to the resolution boundary. */
  private alignDown(ms: number): number {
    return Math.floor(ms / this.resolutionMs) * this.resolutionMs;
  }

  /** Largest request window (ms) that is a whole number of resolution buckets. */
  private windowMs(): number {
    const maxMs = MAX_WINDOW_DAYS * 24 * 60 * MS_PER_MINUTE;
    return Math.max(this.resolutionMs, Math.floor(maxMs / this.resolutionMs) * this.resolutionMs);
  }

  /** Format an epoch (ms) as the API timestamp (UTC, second precision, no suffix). */
  private fmt(ms: number): string {
    return new Date(ms).toISOString().slice(0, 19);
  }

  /** Parse an API timestamp (assumed UTC) back to epoch ms. */
  private parseTs(s: string): number | null {
    if (!s) return null;
    const iso = /([zZ]|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s}Z`;
    const ms = Date.parse(iso);
    return isNaN(ms) ? null : ms;
  }

  /** Extract the floor number from a "floor_<n>" node name. */
  private parseFloorNumber(name: string): number | null {
    const m = /^floor_(-?\d+)$/.exec(name);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return isNaN(n) ? null : n;
  }

  /** Clamp resolution to a valid Schindler value (multiple of 5, divisor of 1440). */
  private validateResolution(resolution: number): number {
    const valid = [5, 10, 15, 20, 30, 60, 120, 240, 360, 480, 720, 1440];
    if (valid.indexOf(resolution) !== -1) return resolution;
    const fallback = valid.reduce((prev, cur) =>
      Math.abs(cur - resolution) < Math.abs(prev - resolution) ? cur : prev
    );
    console.warn(
      `[init] RESOLUTION_MINUTES=${resolution} is invalid – using nearest valid value ${fallback}`
    );
    return fallback;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
