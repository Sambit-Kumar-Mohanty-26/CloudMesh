"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export interface HourlyBucket {
  bucket: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export interface ModelBreakdown {
  model: string;
  requests: number;
  costUsd: number;
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:00`;
}

export default function UsageCharts({
  buckets,
  byModel,
}: {
  buckets: HourlyBucket[];
  byModel: ModelBreakdown[];
}) {
  const tokensSeries = buckets.map((b) => ({
    time: shortTime(b.bucket),
    prompt: b.promptTokens,
    completion: b.completionTokens,
  }));

  return (
    <>
      <h2>Tokens per hour</h2>
      <div style={{ width: "100%", height: 280 }}>
        <ResponsiveContainer>
          <LineChart data={tokensSeries}>
            <CartesianGrid strokeDasharray="3 3" stroke="#232733" />
            <XAxis dataKey="time" stroke="#8b93a3" fontSize={12} />
            <YAxis stroke="#8b93a3" fontSize={12} />
            <Tooltip contentStyle={{ background: "#12151c", border: "1px solid #232733" }} />
            <Legend />
            <Line type="monotone" dataKey="prompt" stroke="#5b8cff" dot={false} />
            <Line type="monotone" dataKey="completion" stroke="#4cc38a" dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <h2>Cost by model</h2>
      <div style={{ width: "100%", height: 280 }}>
        <ResponsiveContainer>
          <BarChart data={byModel}>
            <CartesianGrid strokeDasharray="3 3" stroke="#232733" />
            <XAxis dataKey="model" stroke="#8b93a3" fontSize={12} />
            <YAxis stroke="#8b93a3" fontSize={12} />
            <Tooltip contentStyle={{ background: "#12151c", border: "1px solid #232733" }} />
            <Bar dataKey="costUsd" fill="#5b8cff" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}
