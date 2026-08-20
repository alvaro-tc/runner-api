/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  rootDir: 'src',
  // El seed vive fuera de `src` pero tiene logica propia que probar (la
  // progresion de carga de las plantillas de plan), asi que su carpeta entra
  // como raiz adicional en vez de quedarse sin red.
  roots: ['<rootDir>', '<rootDir>/../prisma'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/$1' },
  testEnvironment: 'node',
  collectCoverageFrom: ['**/*.(t|j)s'],
  coverageDirectory: '../coverage',
};
