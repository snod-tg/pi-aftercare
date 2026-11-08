import { ArrowRight, Check, CircleHelp, RotateCcw, ShieldCheck, Shirt } from 'lucide-react';
import { demoProfile } from '../demo-profile';

const suggestions = [
  'T 恤想换成 L 码，外套想退掉',
  '这笔订单还能退换货吗？',
  '帮我查一下 T 恤有哪些尺码',
];

export function Welcome({
  disabled,
  onSend,
}: {
  disabled: boolean;
  onSend: (text: string) => void;
}) {
  return (
    <div className="welcome">
      <div className="welcome-symbol">
        <Shirt size={34} strokeWidth={1.4} />
        <span>
          <Check size={12} />
        </span>
      </div>
      <h2>你好，{demoProfile.name} 👋</h2>
      <p>
        衣服的尺码不合适，或是改变了主意？
        <br />
        告诉我你的需求，我们一起处理。
      </p>
      <div className="suggestions">
        {suggestions.map((text, i) => (
          <button
            key={text}
            disabled={disabled}
            onClick={() => void onSend(`订单 ${demoProfile.orderId}，${text}`)}
          >
            <span>
              {i === 0 ? (
                <RotateCcw size={17} />
              ) : i === 1 ? (
                <CircleHelp size={17} />
              ) : (
                <Shirt size={17} />
              )}
            </span>
            {text}
            <ArrowRight size={15} />
          </button>
        ))}
      </div>
      <div className="welcome-hint">
        <ShieldCheck size={13} />
        生成方案后，需要你确认才会提交申请
      </div>
    </div>
  );
}
