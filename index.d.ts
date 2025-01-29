import { Adapter } from "@sveltejs/kit";
/// <reference types="@fastly/js-compute" />
import { Geolocation } from "fastly:geolocation";
import "./ambient.js";

export default function plugin(options?: AdapterOptions): Adapter;

export function handleSvelteKitRequest(event: FetchEvent): Promise<Response>;

export interface AdapterOptions {
  out?: string;
  entry?: string;
  staticPublishConfig?: string;
  silent?: boolean;
  experimentalTopLevelAwait?: boolean;
}

export type FastlyConfig = {
  manifest_version: number;
  name: string;
  language: "javascript";
};

export { Geolocation };
