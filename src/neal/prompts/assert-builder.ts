import {
  getPromptSpec,
  type PromptBuilderContract,
  type PromptSpec,
  type PromptSpecId,
  type PromptSpecVariant,
} from './specs.js';

export function assertPromptBuilder<TId extends PromptSpecId>(
  id: TId,
  exportName: string,
  modulePath: PromptBuilderContract['modulePath'],
): PromptSpec {
  const spec = getPromptSpec(id);
  const allowedBuilders = [spec.baseInstructions, ...spec.variants.map((variant) => variant.baseInstructions)];
  const matchingBuilder = allowedBuilders.find((builder) => builder.exportName === exportName);
  if (!matchingBuilder) {
    throw new Error(`Prompt spec ${id} does not expose builder ${exportName}`);
  }
  if (matchingBuilder.modulePath !== modulePath) {
    throw new Error(`Prompt spec ${id} still points ${exportName} at ${matchingBuilder.modulePath}`);
  }
  return spec;
}

export function resolvePrimaryVariant(spec: PromptSpec, specLabel: string): PromptSpecVariant {
  const primary = spec.variants.find((variant) => variant.kind === 'primary');
  if (!primary) {
    throw new Error(`Prompt spec ${specLabel} is missing a primary variant`);
  }
  return primary;
}
