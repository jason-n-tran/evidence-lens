"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import * as d3 from "d3";

interface Neighbor { id: string; title: string; pagerank?: number; year?: string; dir?: "center"|"out"|"in" }
interface Edge { source: string; target: string }
