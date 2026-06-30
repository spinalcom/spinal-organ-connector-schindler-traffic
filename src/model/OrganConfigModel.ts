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

import { spinalCore, Model } from 'spinal-core-connectorjs_type';

/**
 * Persisted organ configuration stored in the SpinalHub.
 * Created once and reloaded on subsequent restarts.
 */
export class OrganConfigModel extends Model {
  digitalTwinPath: spinal.Str;
  pullInterval: spinal.Val;
  /** Backfill history pulled on first start, in minutes. */
  historyDuration: spinal.Val;
  /** Time bucket size requested to the Schindler API, in minutes. */
  resolution: spinal.Val;
  /** Data cursor: aligned epoch (ms) up to which traffic data has been synced. */
  cursor: spinal.Val;
  /** Wall-clock (ms) of the last successful tick (informational). */
  lastSync: spinal.Val;
  restart: spinal.Bool;

  constructor() {
    super();
    this.add_attr('digitalTwinPath', '/__users__/admin/Digital twin');
    this.add_attr('restart', false);
    this.add_attr('pullInterval', 300000);
    this.add_attr('historyDuration', 1440);
    this.add_attr('resolution', 60);
    this.add_attr('cursor', 0);
    this.add_attr('lastSync', 0);
  }

  /** Apply values from environment variables (called only on first creation). */
  initEnv(): void {
    if (process.env.DIGITALTWIN_PATH)
      this.digitalTwinPath.set(process.env.DIGITALTWIN_PATH);
    if (process.env.PULL_INTERVAL)
      this.pullInterval.set(Number(process.env.PULL_INTERVAL));
    if (process.env.HISTORY_DURATION_MINUTES)
      this.historyDuration.set(Number(process.env.HISTORY_DURATION_MINUTES));
    if (process.env.RESOLUTION_MINUTES)
      this.resolution.set(Number(process.env.RESOLUTION_MINUTES));
  }

  /** Persist the data cursor (aligned epoch ms). */
  setCursor(epochMs: number): void {
    this.cursor.set(epochMs);
  }

  updateSync(): void {
    this.lastSync.set(Date.now());
  }

  /** Bind the restart flag so that setting it to true exits the process (pm2 restarts it). */
  bindRestart(): void {
    this.restart.bind(() => {
      if (this.restart.get() === true) {
        console.log('[OrganConfig] Restart requested via BOS flag');
        process.exit(0);
      }
    });
  }
}

spinalCore.register_models(OrganConfigModel);
