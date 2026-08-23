import deepseekIcon from "@lobehub/icons-static-svg/icons/deepseek-color.svg";
import kimiIcon from "@lobehub/icons-static-svg/icons/kimi-color.svg";
import minimaxIcon from "@lobehub/icons-static-svg/icons/minimax-color.svg";
import openaiIcon from "@lobehub/icons-static-svg/icons/openai.svg";
import qwenIcon from "@lobehub/icons-static-svg/icons/qwen-color.svg";
import siliconflowIcon from "@lobehub/icons-static-svg/icons/siliconcloud-color.svg";
import mimoIcon from "@lobehub/icons-static-svg/icons/xiaomimimo.svg";
import zhipuIcon from "@lobehub/icons-static-svg/icons/zhipu-color.svg";
import { Bot } from "lucide-react";

interface ProviderIconProps {
  provider: string;
  size?: "small" | "medium";
}

const providerIcons: Record<string, string> = {
  openai: openaiIcon,
  deepseek: deepseekIcon,
  qwen: qwenIcon,
  kimi: kimiIcon,
  zhipu: zhipuIcon,
  siliconflow: siliconflowIcon,
  minimax: minimaxIcon,
  mimo: mimoIcon,
};

export function ProviderIcon({ provider, size = "medium" }: ProviderIconProps) {
  const icon = providerIcons[provider];
  return (
    <span className="provider-icon" data-provider={provider} data-size={size} aria-hidden="true">
      {icon ? <img src={icon} alt="" /> : <Bot data-testid="provider-fallback-icon" />}
    </span>
  );
}
