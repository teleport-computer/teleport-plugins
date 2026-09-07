// Public face of an OAuth3 instance: the index (/), privacy policy (/privacy), and terms
// (/terms). These exist so the instance can be a real public identity service — federated
// providers (Google) require a reachable home page + privacy policy + ToS, and the index is
// where the "this is a personal instance, run your own" framing lives (see issue #32).
// OWNER_NAME / SOURCE_URL are optional env overrides surfaced in the copy.

import { DESIGN_CSS } from "./design.ts";

const SOURCE = "https://github.com/teleport-computer/oauth3-server";
const ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAYAAABV7bNHAAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAABmJLR0QAAAAAAAD5Q7t/AAAAB3RJTUUH6gYaDQonnNIerQAAKf5JREFUeNrVfHl0W+WZ9+9KupKs3fKqxbusXfImecluJ2QhkJZkCFshJG1p5ytbmrbp9zXQdqaEaTlTOhTClAJd0rAEMjBshYQACVlJ4sSLvMd27NiWd3mRLVnL8/0h6SbGodBlOjPvOfccnXuv7vu+z31+z/5cBn+/wQLQJCUlmbOyshw5OTk2rVZTkJKSqlUnq5UisUjK5/OTACAajc7Ozs76x8bGJkZHR/u9Xu/Fy5cve3p7exumpqZaAAwACP09Fs38Fz9fDMCYnZ29tKioaFlRUZHT4XDo8vPzZenp6YxEIgHDMAiFQgiFQohEIiAisCwLlmUhEAgAAmZmZzAyMkI9PT3Tra2tfQ0NDfXnz58/2tLS8nEkEmkDEPjfRCAGQKZCobjO7XZvqq6urly6dGma0WhkAAaXe3vgaWpCU3MTujq74PV64fP5MDM7g2gkAj5fAACQSCRQqVTIzMxEfn4+LBYLTCYTsrOywQpZdHdfouPHjw0fPnz41PHjxw+MjY0dAuAFQP9TCcQAyElJSbm1urr69o0bN1qWLl0m4PN5OHv2LN57912cOHkSnZ2dmJycBNHCfdxwww1QyOV44cUXIRAIEI1GEY1GYw9nGMjlcmRlZcHtdmPNmjVYvHgxBAIBjh8/Hn711Veb33///RdGR0dfAnDpb02ov3akSaXS7TfeeGPzgQMHoiMjI1Rf30C7du0ip9NJIpGIAJBIJCKGYQgAMQxDqampxOPxCAClpqTQm2++SQcOHCCTyUSlJSUkk8lIqVRSfLPE5/NJKBQSABIIBGQymWjnzp1UV1dHo6Oj9Mr+V6Jr165tFovF2wGk/XcTBYgJ3vVOp/Pjp556Kjw0OER1F+roW9/6Fmk0GuLxeCQQCLgN5ubmUmFhIfF4PDIajWS32wkAicVievTRf6FgMEjt7e30k5/8hNLS0ohlWSorK6PMjAwSCATkcDgoLTWNe55AICCGYUiTmUn33XcfNTY2ktfrpcceeyxcWFj4MYD18TX+t4xMsVj82K233uqrq6ujy5cv00O7dpFWqyUAJJVKadmyZZSWdmVDDMOQ2WymNWvWkN1u57jHZDRSY2MjERGFw2E6efIk5efnx4knosrKSlq1ahXp9XruWQAoOzubqqqquJeQnZ1Nux/ZTYODg3Tq1Claf/31PoFA8BiAzL90k7y/8H/u9PT0F37wgx/sePKXTyp7enrw5S9/GT955BH09/eDFQhgMVsglUqRlJR01d+I01JEsd8ymQx3bdkCg8EAikbB4/FgsViweMkSiEQiRCJRgAAhy4Ioyj0pIZPUajUMhgIwDIOenh7semgXbtm8GaFQCM89/7zyvvvu2yGXy18A4P57cA0PwE0FBQUdL774Eo2MjNKuXbtIqVQSy7Ikk8lIIBBQaUkp5eXmEcsKqLi4mLKzsznusdlsxOfzyWwykdlsonXr1tHw8AhFo1GKRCIUiUQoGAzS/v37yW63U1lpKel0OhIKheR2uykrK4sYhiGr1UoWi4X4fD5ZLRYym83E4/FIoVAQwzCUmZlJTz75JE34JujffvFvlJaW1gHgpr+CKT53CABss9lsw4cPf0CXui/R5s2bic/nE4D4BlxUXV1NOTm58+REUVERVa+oJqvVysGKYRjKycmmXzz+CyIijjiRSISi0Sj19fXRTTd9mTSZmdyzhEIhuVyxOUwm0zyBb7FYqKamhpxOJ3deLBbTAw88QMPDw7Rv3z7SaDTDALbF9/KFOeKLEuceu83+82d+9UyqRqPBlru3YP/+/YhEIgCASCQCgYCFUqGE3z/N/TEcDiMcDkOdoobf7+fUNhEhFAqjZmXNNScUi8UYGRnFgNfLnUsYlMnJyZjx+zlTgYgQCASQnJzMGZsAEAgE8Mtf/hIP3H8/aqqr8cQTT6RqNJqfA7jnzyHSFyHitsLCQt/Ro0fJ4/FQZWUlASCNRkNSqZT4fD6VlJRSXl4eSaVSqiivoNTUVAJAFouFbDYbCYVCKi4qouzsbAJAMpmMVq9eTUODQ0RXwStxhEIheuCBB8hsNpNKpSKGYchms5HJZCKRSERlZWWUlZXFaceSkhISCoVktVrJbDYRAFKr1aRWqwkAbdy4kfr6+mnfvn2kVqt9cU76m8DtpszMzOE333iTOjo6aMmSJRzLq9VqKne7qaqqitM6iGswt9tNFRUV82AlEAjI6XRSeXk5VVRU0KuvvroAXomDiOj06dNksZipoqKCKisryWg0cvARCoVUVlpKlZWVVFxcTCzLEgDiMQxZLRaqrKwkt9tNEomEW9ctt9xCg4OD9POf/5zEYvEwYjLpc7njTw13kjjpsR/8vx+kutwuPPjggzh27Bh3cWJiAkkSCTIzMzE4OMid9/v9mJubQ35+PoaHhzlYhcNhTE5OQqvVQiQSobKy6jMnJiLYbHbk5eVjaGgIer0ew8PDHHzm5uYwMTmJgvwC+Hw+hEIx3zVKhOGREeTl5SEUCmFmZoZ75v79+/GTn/wEW7Zswd13350K4Gf4K7RbJoAPtm3bRqOjo3TvvfcSwzCUlpZGQqEwDqsSys/LI7VaTW63m6RSacyuMZnIZrORTCaj8vJyDm56vZ7KyspIKBTS7kce+UzuuVpYHzp0iDIzM0khl1NlZQUlJydzsCouLiaJRDIPbqmpqVReXk4ymSwONzPH1UqlkkQiET3xxBPU09NDixYtIgAf4C+wkwQAHityOqmjo4Oee+45SkpK4uROaWkpuV0uMhQUzIOby+Wi4qLieUZgAm52u51KS0uJZVnS6/XU2ND4+QSKRCkQCNDGjTcRAFIoFFReXk5Oh2MerIRCIZWVlZHT6SSXy8W9KB6PRzabjYqLi8ntdnPE1Wg0dPToUTp06BClpKQQgMfwGUL7syC2RiKRfP373/+/mJ2dxe7duzE7OwsAGBwchFqthk6vR+/ly9wfxsbGwDAMrDYrent7OVj5/X5M+HxwuVwYHPQiFAph0aJFMBQauHs+E2YgiEQi3H77HZDJZJicnMTMzAyKiovR39fHwWpubg4DAwMoKSnB5OQk/H5/DG7RKHp7e2E2m8EwDMbHxwEAAwMD+OEPfwibzYavfe1rAPB1AGu+KPekAzi6efNmGhkZoa985SucrcHj8cjpdJLBYCCtVktlZWUkEsWcR6PRSA6Hg1JTU8ntdpNMJiMApNPpyO12UXJyMrldLsrJzqa33377mtwTvYY2i0ajND4+TitWLCe9Xk/FxcWUnJxM5eXlHEckYKVSqebBTSaVUXlco1qtVjKZTBzH83g8enT3o9TV1UVOh4MAHI3v/XPH9tTU1MiJEyfotddeI4lEQkqlkqxWKzmdTiosLOQm0el0VFJSQlarlYqKijijMQE3g8FAbrebxOIr3vzWu7fSxMTENYlRV1dPk5OTC64RET311FOk0WhIGIdVAm4FBQXz5J9QKCRXmYuMRiOVu6/IPx6PRw67nez2mKnAsizl5ORQfX09/fu//zsJBIIIgO2fB7E8AF/fuHEjr6CgAE888QRmZmYwPT2NvLw8ZGdno6uri7u5r68PEokERUVFaG9v54zGsbExzPj9WLJkCbq6OhEIBGMsH4li3fXroFAoPhUPikUVX3rpRXR0dIBhFoapVq1aidTUFMzFYTU5OYnh4WEsX74c/f39HKzm5ubQ2dWJRYsWYTYwi5GREQ5u7R0dsFisyMzIQCgUwqVLl/DrX/8aX9qwAS6XixeHWt6f4p7vp6am0unTp+mFF14glmWJYRiy2+1kNBrJWFhIDoeDE8AGg4GK4sZfQjshLgRdLhdpNRpyu67AraCggFqaWxbAi4iora2NCgsL6fHHH78m/IiInnzySc4OSkA5MyNjHtykUimVl1eQRqOhstJSLgLAsiyVlJRQbm4u2Ww2DgmZmZlUW1tLzzzzTGJf3/8s4mgB1N126200PDxM161aRQA46zUBK6PRSDarlQwFBVRSUkKCOKwS8iFLr4/DSkwAKCUlhdwuFykVCnr88cevCS0ioscff5wA0KaNG2l6evqaMGtrayODwcDJnASsEnDTarXkdrs5WIlEInK5XJSTk0PFRUWUk5NzFdwcVBDXwjt27KCenp5EfKouTosFY4tYLA6/+eabdPDgQZJIJORyuWjVqlUcxySE9cqaGrr55pu5SGHiKC0tpTvvvHNeFBAA5eXl0V133cXFfD698c7OTrJarRwH7N+//5pcFA6H6YknnqBbNm9OqGfu0Gq1tHXrVm7TiUMuk9FX7riDysvL551nWZbWrV1Lep2O8vPz6eLFi/TQQw8RgDCALZ+WQWIAN9msNr7b7carr76KmZkZdHZ2YmhoCHl5V2CZm5uLsfFxNDY2wGAwgMeLPSIzMxN8Hg+nTp1EQUEBWDYWyFMqlVCr1QgGg9DpdNeMRbe3tcEXV8F+vx8vv/wyZmZmFsgiPp+PqqoqNDc3Iy83F2KxGAAgk8mg1+vx0UcfIkWthkqlAgCwLAuDwYDTn5xGJBKGTqeLSTyGgcFgwKWeHgyPDKOrqwuHDx/GDTfcgOTkZD5iLoj4agIZAVRet/o6BAIBfPDBB5yw9Xg8kEgkyMvLQ25uLpKTk9HQ0IDm5haEQiGYTCZkZmYiOzsbjR4P2ts7MDo6CrvdjpQUNUwmEwYHvfiHTZugUqnmEYhhGExPT2Pfvn3IyMyAXq9HXl4eurq6UHehbgGBiAi5ublQKJW4fPkyHA4H1Go1rFYrOjs70dXVjdbWVpiMRqSmpMBmtWJsfBzt7R1obPRAq9VCp9PBaDQCAJqbmxEMzoGI8NZbbyE/Lx/FxcUAUBmnCUegJUlJSRkrV67EmTNn0N3dzS0qEomgqakJJpMJDocdDQ0NCIfDAIC2tjYkJ6uwYvlyeDwezpi8dOkS5ubmsH79DWhvb0d+Xj5Wr16zgHsYhkFHRwfefe89eDxNcLlcyM/PR21tLQ78xwFEo7SAQKmpqbjjjjvgHRzE+Pg4NmzYgL6+Pk5bTUxOouPiRVy/fj3CkQguXboEAAgGg2hsbERVVRUyMjLQ0tIybz1nz57FyOgIampqACADwJIEgVgAy7Ozs2E2m/Hhhx8iEglDLpdzf445ikPo6+tDll7PnU9PT0c4FEZTczOys7O5N65QKCCXy3D+fC1SU1OxeMmSa6j2GPF/+9vfYmhoCNnZ2bh06RImJiag1Wjw1ltv4dKlbg7CV4/q6mqYTCYolUqcPXsWmsxMiEQiAIBAIEBWVhZqa2shSUri4MYwDLL0erS1tmJ6ehrp6TGbUCwWQyKRwOv14uzZs1i8eHEiTLwcAMsDoAHgtNvtYFkWn3zyCQAGRmMhMjIykJWVhRR1Curq6lFXVw+FUonc3FykpaUhLy8PjR4P6uvrEY1GYTKZoFAoYLFY0NrahoaGRgSDQaxdu3ZBBo7H46G/vx/vv/8+8vPzIRaLUVdXh/r6emg0Gvj9fuzfv38BcaLRKPLz87F+/Xq0t7ehsbERA14vHA4HpFIp7DY7fD4fGhsb0dLaCoPBAIVCDpvVBq1Oh3AkAq1Wi4cffhiP/su/4B//8R9hsVgQjUZx7NgxFOQXJGSVE4BGAMAMQOcqc2FwcBDd3V0gIng8TVi1ciVmAwEcOXKEg1VDQwOWL1sGpUqF9957jwsntLa2oqysFOvWrcP7hw5xfk9+fj5KS0qvKZyPHDkCvV6PqclJnDp1ClEizM3NoaGxAUuWLMVgHEafll0sy+Kmm27Cc889ByBmsPL5fHzpS1+aJyIYhkFqairuueceOBwOAAyUSgU0Gg1kMjkmJydw7NgxTE9PY8bvh8fjgUgsgslkQkdHhw6AWQDAwbKszGa3ob29HePjPgBAamoqRkdHQURITlZjeHgIAKBWqzEbCGBmYADp6encYuRyOYRCES5duoS09HSMjY+DiLB82XJIpJIFwtnv9+OTTz7B+NgYwDBQKJXw+WJzq5Nj4dnW1laMjY4iOTl53v9jsSIbnE4nPv74Y/B4PCgVSgz090Ov18PlcqGqshLFJaWwWa1QJauuQJViTnAio7J8+QoIhUI0Nzehu6sLPp8PNpsNb7/9tgyAQwDAplAomNzcXLz55puIRCLQ6/XIyMjA2XPnIBAIYLfbARCi0SgKCgpQX1+PYDAIp9MJIsLo6ChsNhva2towNjbG5dEnfD5s+odN4PF48zx3hmFw7tw5vPHGG+jp6YFcLofVakVzczOSkpKQlZWFugt1iEQjeOXVV7HzezsXCOvk5GSsXbsWbW1tWLZ0KdasWYvsnGwUFBRAq9FCnCTm7iWiBZEDIsLg4CCOHD2KP+zdizOfnAHD4+Hy5cswm81ATCjYAOCjwsJC6u3ppa9u2xaLHRcXc24D4tmBVatW0Zo1azjrFfEQ6qJFi2jDhg1c7BdxY9JYWEhbt26lCd+1HdP77rtvvkEnl9O6deuopqZmngFqNpups7PzmpmP4aFh8ng85Pf7KRqNEhFRNBqlaCT6J4NwRETBYJCOHDlKN228iXQ6HWVnZxOPx6Pnn3+eDh06lFjDRzwAWrVaDVbIoq+/H9FoFHw+j9MKACCVSBGam8PMzMy8RKBIJAIRYWpqClKpdJ6MECclYdOmTVAo52svHsPD4OAgzp8/HytviQ+ZVIqZmRkEg8F5c7S2tuKdd95ZIL+ICCmpKbBYLEgSJ3FcQkSga9QtMAwDhmEwNjaGd955B1u3bsXdd9+F1/7jNQQCASgUCkSjUfT19UGtVifWoBMAUCaE4NjYGMLhMDo7u2C1WuHxeCBkWRQaC3GuthaRSCQON2BmZgZ2W0xuTUxMwOlwAAC8Xi+sVisyMzNRVFSEhSsF/vjHP6K7uxvFRUWob2hASkoK9Ho9Tp8+BaFQBIvZjJaWFkz7/dDr9fCN+xCJRK5pOP6pwcQoAwAIzAbQ0tqCffv24fXXX4dYLMbQ0DBSUtQoKCiAx+MBAIyMjEAqlSasdIUAgEwulyMSiWB6OpbPGh8fR1trKyoqKhAOh3Hu3DnumsfTiLIyF8QiMWrP12J0dBQAUN/QgJKSYthsNtTX12PN6jXQarULZM/U1BReeuklXL58GZFIBNXV1ZiamkJt7TkEAkEEAkF0X+rGV+68E2VlZVi0aBGys7KvGQL5TMLEuSUYDKK3txe9vb14/vnn8f77hzA8PIJIJAK1Wo1FVVUIBoM4V1vLhUump6chFAoTBJIJACSJhCJEo1FOlSfeDo/HA8MwC2I3scUScPV5il9DrPhp5cqV1xTODQ0NOHv2LABw12ZnZ8HnC1BdvQhutxvFxcVYs2YN1Gp1bO645vkiRAGAnp4edHZ24p133sGJEyegUqng9Q5gdHSMi1lFo1GAYcDj8+ftIxgIgs/nJ+CfJLjCi1eGSqWCyWTC6dOnwLIs7HY7GhsbEY1G4XA40NzcHIOY3Q7m4kX4fD44HA54vV7U1tZiy5YtqKisuLbt89FHGB8fh06ng91ux8TEBDZt2oSK8gqUlJZArVZz935ezPrqMTk5idraWly4cAEnT57Eu+++C5lMBp1Oi0OHDiEjIwNOpxP19fWQSqUwGo04dfIkRGIx7A4HGhsb4ff7ORMgMQQAZkOhkITH40HA5yMpKQlGoxEtzc2YnJyK39aB0tJSAEBLSwuGh4fjcPPA4XCAZVl0d3ejp6cHAFBWWsoJvavf8ODgILyDg1i6dCk2b96MlStXQqlUQpOpAcNjOJX85w4ew8MzzzyDf/qnH2N62o/CwkKUlpRg2u9HQ0Mj5ubm0NvbCwCoqqrC3NwcPB4PpqanMTU9DYYBjEYjzp8/D5Zlr0bTrCAGu2kJn8+HOEnMaa+rE24zfj/EYjEYBpwsSkCDYRio1TEPH4j5bSuqq68JgfHxcdx+++344cM/hEwug1Ao5IhC0S8GoWsSkQEMBgNCoZiI8Pv9SE1Lg29iAnNzc/O4TKlUYsLn4xxrAJiejtUM8HgMpFIpQqEQgsEgAEzzAEz4fL74RlPg8/kw0N8PhzPGGUlicZw161BbWwu73Q6JRAI+nw+Hw4GB/n4cPvwB54ctXbIU+fn5CzYcjUZhNBpRXl6OZHUyV4P4pziGYRjweDxEIhE0NjbinXfeQVNTE3jMpxxYAhYtWgSbzYqMjAzodDq8/fbbCAaDsFgsYBgGSqUSZrMZR44cwaWeHhQVFUEgEEAsFsNsNqOvrw/RaCxa4Pf7EQgEAGBSAKB/bGysMBwOIzMzlmBM5LtKS0vAgIfuS90YHByKL5oHh8MBihKGhoc4V6OlpQUlJSXY9tVtEIlEnyk/Plc1xzklHA6jv68fZ8+dxYkTJ/Diiy9iZGQEd911F/bs2QM+n3+F+BRFWloaNm++BX/4wx/Q0NCAQCAQiw2ZTHC5XGAYBi0tLZicnMTk5CSAmCiYiwfvx8bGAABarRZjY2MJDusTAOgcGxtbPjExgdzcXG7S4ZERlJSWYmZmhou1ALEgmt1mh0wuQ31DPcRiMYxGI7Zs2YLqFdWwO+x/lnC9mijRKKGrqwtnzpzB2bNnUV9fj1OnTl4lC4HTp06hu7sbhYWF8+bh8XjYvHkznn/++cTbBxHB6/WiqKgInZ2dmJiY4O4fGhyE0+HE1PQUd14oFCInJweXL19OPKNTAMDj8/mop6eXMZlMAGIxEqfTiTNnzkDIsnA6HKhvaAARwWq14mLnRajVauz83vdQXlEBp9PJhTO/qJBNECUSiWB0dBTnz5/Hu+++i8OHD0MoFKKnpwdEBGOhEY0eDwKBAAoLCzEzO4u9e/fiRz/60QIIZ2VlYfXq1RgYGMDU1BQHq4MHDyIjIwMWiwUtLS0QCoWwOxw4c/YMt9e6ujqoVCpkZWXh6MdH48CFRwCgYW5ubrqpySNfunQpFAoFpFIpent7MTAwENsMj0EiXiSTyeB2u3Hvt+6F3WGfV2/4xTklCq/Xi+PHj+PgwYM4e/YshoaGIJfJIBKL4fV6MTQUgzSfz4fVakUwGAQRoampCe+99x4eeOCBK3ZSfAgEAmzYsAHnzp3DxMQEZDIZWltbMD7ug8/ng9lshsNhh5AVoq+vD954cVY4HEaSWIysrCwkJyfD0+gBgGkADQIALQD6amtrzbfeeitycnI4jZQYly/3YfXqtbjttluh1+mRlZ0V88Oi9LlwYgAwcYPR6/WitbUVp0+fxgcffIAPP/yQy6+LRCK4XS5MTk7Om9/r9aIgPx8FBQWcT9be3g6PpwnLli1dEAZxuVxQq9XIzs6Gx+PhwjdEhO7ubqxfvx6Dg4Po7++/an8xmetwODA3F0JzczMA9MVpAxbAyw6Hg/r7++nuu+8mAJSRkUEsKyCVUkm33XYbHTx4kPz+mc+tyPh0dcbs7CwdOXKEvr9zJ9XUVNOSJUtJIpGQ0+kknU7HpYtLS0spK0tPBoOBK7piGIZMJhNZrVbSaDLJ5XJx+bY77riDAoEARa+RY/vxj39MUqmUSktKKCde0RarAHGRXq8js9nM1Tjy+XyucuXZZ5+lDz/8MFF09TIAVoBY18yRrq6uze3t7aipqcHevXuhUqkg4PMhVyjgdDqRlpYGHo8B/RkCmOExOHv2LB544AGMjIwgMyMDrW1tmJmZQUtLC+x2O4RCIVQqFYaGhnD58mUwDFBYaITZbI7VPfL5aG5pibclxAJlg4ODuHjxInp6elBYWLhgTcuWLcOePXtQ39CAIqcTApaFQqGA1zuAvr4+8BgG5njMSiAQYGx0FHK5HJWVlXj99dcTNuARAKGEQXFsenp68PD7h1FVVQW9Xof29nZYrFb87GeP4Rvf+AaKi4shEgo5j4iJ+2R/yomMRqN45ZVXMD4+juuuuw4DXi+mpmIaaW5uDu3t7Vy/RYLNiYCLHR3IysqC0WhEa1sbB+PBwUGEw2HUVNegvb0Nhw4dWjAnRaNYsmQJ1q9fj3A4jNa2NlRWVkIgEKCvry+2LiK0t7fDaDQiNTUV/QMDKHe7kZaWhg9jKa9BAMcAIGFMTACoDAQC5i13b0F7exvkcjl27dqF0tJSiEQiCFkWYK4QZS40h76+Prz99juYmPAhNyd3nkPJ4/HQ3d2NZ555BizLoq6uDlqtFn6/H8FgECKRCFarDU1NTRCLRBAJhZiYmADDMDCazJicnMDw0BDSMzK40K9Wq4VSqYTH40FGRiYGBgZw/fXXf6pYPSbYKUr44x//CGNhIVpaWyEWiyGMz8Hj8WC1WDA8NIT2jg6EQiF8e8cOJCUl4bHHHkMgEDgM4FcAwomIVQDAaw2NDTecP3+ef8stt+Kee+7B9u3b8eUvfxlbt27lBN358+dRV1eHI0eOoKOjA6G5OTz11J6YNP6UIrt48WLsLba2YmpqCtPT0zCZTOju7kZ2Vjb6+/vQ39+PgYEBLp4kTkoCj2HQ3NIcU/NGIywWC3w+HzQaDRobGxEIBBAMBqFQKHDy5Elcf/31C7RoeUU5Fi1ahAsXLsDr9XJzJGLRc6EQWltbAQCFhYW47rrr8Jvf/Abj4+MRAK/hGj1oWgB1d955Fw0PD1N19QpiWZZWrVpFd9x+O+3YsYO2b//2vNAqAKqqqqKRT1XKJ/LozzzzzIL7MzMz6e67t3K1g4lDJBLRpo0bqaamhnjxCo7EsWTJErpl8+Z54V7Ec/579+69Zkg3FArRt7/97Xn3i8Vi2rRpEy1btoyrEgFA3/3ud6m3t5ccsUKqecUL/KsINAVA5fUOrFq/fj2ys3PwxhtvoL29HZOTE7h8uQ8XL14EK2AxNh4zy0UiEbZt24Y1a+dnTXk8Hi5cuIAf/ehHUKmUGIvHYcRiMQwGAy52dEChUGB2dhaBQAAMw6CwsBDjPh9Cc3MQsCxn3er1eohEIvT1x0KhIyMjICIoFAro9Xp0dXVizZq1kEgkC2Cm0+nwxhtvYGpqKgZdowljY6OIRiJgeDxMTU1Bq9XiZz/7GT766CP85je/ARH9AsAfP0uu5gFo+uY3vklDQ0NUU1MdbxnIIYFAECsbcTjIYDBQeno6LVu27DMrNnbv3k0AKEuvJ5fLRQqFglwuN2k0Gq5kpbKykpKTk8lsNpPFYiGGYYhl2bjKzyKdTjev7qiwsJBsNhupVCoqLy/nekT2/v731wzqDw0N0cqVK0kuk3FzJLhVF+9KevDBB6m/v58qKioIQBM+p4AKALanpaVFjh07Tm+88QbJ5fJ5bMrj8ai6uppuWL+eduzYQcFgcJ4tEo1GaXR0jJYuXcr9x2Aw0F133sVV2ScOlUpFt916K5W73QtKU9auWUPXX3/9vOwKACopKabbbruNUlKuQHfjxo00Ozt7zWzGo48+Shtv2pggwLyjoKCAmpqa6KmnniI+n/+FSvAAYN/w8PDxX/zicSxevBg333zzvIvpaenw+6cRCAbxla/cGYvpXHWdYRgcO/Yxzp07FxO6YjFUKhUaGxuQmpoCoVDIwVCj0aCtvQ0Mj8fl0AEgIyMDo2NjGB4eQmZGBndeoVCAZYVobW1FRkYmlww8ceIE6uvrwfDmmxw8Hg9Lly7FpZ5LoGgUycnJV0FQgPvuuw9CVoinnnoKkUjkOIB9n8c9ibE+KSnJ97vf/Y6am5s51kxJSSG3200sy9K2bdtobm5uwRsLBoP03e98hwoLCykpKYnc7iuwysrKInfcGr666lSpVFJlZSWpVCrS6XRcPXUCbtnZWaRQKKiiooJUKlWs0q2wkOw2G4nFYsrLy6Wnn376mlBvbm4mk8kUK827qvr2xhtvpMHBQbr//vsJgA+x7sQvPAQAHrNardTS3EIvvfQSyWQykkqlnKn/zW9+k2ZnZufBi4jI4/FQfn4+Oex22nzzZq4DMXFkZ2fT5s2byWazzTuvUChow4030rJly4hlr7RxCgQCWrp0CW3YsGFB5ZrVYqGb/+Fm0uv1tGjRIuro6JhHpGiU6MSJE7SypoYAkEQiIaFQSAUFBVRbe55ef/31xDP/7ELyMIB/bWpq+vDH//RjrFq1Cvfff/88rZOfnw+RWLQg13DgwAH09fVBJBLDO+iFXC7nrG0ejweZTAav14ukuOGWGHK5HOO+WP5LIrmShJRKpQiHIxgfH4dSoeDOsywb8/wHvZDLZDh37hwOHz48by0MAwiFIozHc/6JxOfu3bshkSTh4YcfxsTExIcA/jW+5z97uFmWbd/9yG4aHh6m22+7Lfa25XJ6+eWXaWxsnEJzIY57Wltbqbi4iErjXYILOgOtNjIajVzRp8vlIqFQyPVwsCxLSqWSKioqSKlUcsWZSqWSBAIBlZSUUE5OzjxNh7h2s5jNdOedd9LMzAyFw2EKhUIUCATI4/GQwWDgtNdPf/pTGhwcpI03bSQA7ficZhb+5xCoPxqNXq49X7vSZDJJvva1r6GpqQmtLS0YHhkBn8+H0+mAQCDA5OQk9u7di9HRUVy8eJELJ4yMjCA9PR1utxvDw8Noa2sDEAug8xgGVVVVELAsLly4wAXLp6am4HK5oNFo0NDQgMnJSUSjUYyMjMBgKIDTWYSuri4uUzE2Nga1Wg2lUoW0tHQEg0EolUocO3YMoVAYr732H5icnMT27d/G/fffh0ceeQS/+/3vRojofgCH/xQBvkhD2X+Oj4/v3Llz50RDQwOe3vM0albW4OjRo/B4GsHn8dHW1oY9e/bgo48+AkDzHNirg2SJROTVGIhEo7Hg/DXSyp92hhmGASgW4LqWkzw1NYnnnnsWv//97zHQP4CDBw/iO9/ZAb/fj+3bt+P739+JPXv24Omnn56IRqM7AfznXwKraw0BgP+Tn5/ve/fdd+lSdzd96UsbyO1208kTJ+n2228nrVZLKpWK6yvV6/Vcl6DRaCI+n082m43MZjMxTEyjJbRVor5ZJBKRUqmk8vIKUigUnDGpUqk4WOn1+hjcimNF4QzDkMlo4mJIarWa0tPT6atf/SqtW7eOhEIh/fDhh2lsbJweffRRkkqlPgD/B3/DlsyribQtNzd3+MCBA+T1emnHjh3kdDjm+TUASBTvUF6xYsW8LkEej0c2q5VWrFhBJSVX2pkQr3NesWIFLVq0iBQKBXdeqVTS4sWLadnSpVyADXHtVlxcTNXV85uFcZVBm5ubQ7/61a9obGycHtr1EEkkkv+ypl4gJuV/293dfc+999578bXXXsNDux7C177+dWi1mnk3JppvU1JSMD09zflp0WgU034/UlJSMDcX4sKtQCzZJ5FIIGSFCAauONKJemmlUomZeIEBEIPZ3NwcUlJSEAgEFoR+XS4Xnnv2edx4w43YufN7+OnPfnpxZmbmHgC/xV+osf6c4VYoFB985zvfiQ4NDdHx4ydo9erV3BcQUlNTqaCggMRicaxnI24LZWdnU0lJCYmEQrJd1Q2oVCrJ7XKRXC4n3VVwY9lYKFar1ZJcLud8N8RbIqxWK4lEIrJarVxvqkKuoHvvvZd6enrozJmzVFNTE2UY5gP8nT4scPXIZAWCx9atW+c7duw4jYyM0OOPP06GgoJ5kEv0S7hcrvnNt7yYCeB2u6m0tHSez6fT6aiyspLK3e55hmZMJlVQWVkZWcyWebBiWZaWL19Ob731No2OjtHTe56mvLw8H2JG4F/8aYq/drAA1ufl5X38z//8z+He3l5qa2ujnTt3Uk5ODkcoqVRK69at495+4khRq2nz5s1UWlLyqdiQkNauWUPr1q1b0A9iMBho+fLlHHFYlqWK8nJ69te/pqGhITp54iRt3LgxnJSU9N/+cZOrRxrLstuXLF7c/Oyzz0YHBgaotbWVHn30UXK5XJSUlEQMw8zjLIFAQFarjRRyOVktFq6tPGEQajSZpNVoOMMSVwlfhmEoNSWFbrzxRtq3bx95B7xUX99ADz74YFSn0zUj5pX/TT6P8zf/wJJUKr21qqrq9k2bNlmuu+46gUwmQ11dHd577z0cP34cHR0d8I2Pc/ZPolBLIpFgenoafD4fYrGYq/hK3CMWi5GRkQG73Y7q6mrU1NQgKysbbW2teOWVV8Jvvvlm88WLF18A8Df9wNJ/2Se6RCLRdU6nY1NNzcrKFStWpNlsNkYkEqG/fwAtLc1obm5GZ2cnBgYG4IuXoyQMQKFQCLlMhpTUVGRlZcFkMsFiscBQYIBMHvPlTpw4QYcOHRo+efLkqf7+/gMA/sd/outaQwzAmJaWttRms3EfeTMYDDKNRsMoFIpYBoIIkXAEUYpyJS98Ph8MwyAQCGB0dBRdXV3U2Ng4ff78+b6Ghob67u7uo6FQ6GMA/+s+8vZZgwWg4fP55oyMDIdWq7VpNJqC9PR0rVKpVEokEimfz0+KRqOYm5ubnZqa8o+Ojk54vd7+/v7+iwMDA57p6ekGxNLBf7fPBP5/8RUFravaSnEAAAAldEVYdGRhdGU6Y3JlYXRlADIwMjYtMDYtMjZUMTM6MDU6MDErMDA6MDAEh4MKAAAAJXRFWHRkYXRlOm1vZGlmeQAyMDI2LTA2LTI2VDEzOjA1OjAxKzAwOjAwddo7tgAAAABJRU5ErkJggg==";

function shell(title: string, body: string, brandWord = "oauth<b>3</b>", appName = "OAuth3", base = ""): string {
  // The pages use relative links (login/privacy/terms/evidence). When the instance is mounted
  // under a path prefix (e.g. /oauth3) and reached WITHOUT a trailing slash, relative links
  // resolve against the wrong base (/login instead of /oauth3/login). A <base> pins them.
  return `<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
${base ? `<base href="${base.replace(/\/$/, "")}/">` : ""}
<title>${title} — ${appName}</title>
<link rel=icon href="${ICON}">
<style>
${DESIGN_CSS}
 /* page-local shell layout — colors flow through tokens, no hardcoded hex */
 body{max-width:44rem;margin:3rem auto;padding:0 1.2rem}
 .wordmark{display:flex;margin-bottom:22px}
 h1{font-size:26px;margin:0 0 6px;color:var(--text)} h2{font-size:16px;margin:26px 0 6px;color:var(--text)}
 .lede{color:var(--faint);font-size:17px;margin:0 0 20px}
 .muted{color:var(--faint);font-size:13px}
 .row{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0}
 .note{margin:18px 0}
 .halftone{margin-top:36px}
 footer{margin-top:12px;font-size:13px;color:var(--faint)}
 footer a{color:var(--faint);margin-right:14px}
 ul{padding-left:20px} li{margin:4px 0}
</style></head><body>
<div class=wordmark><img src="${ICON}" width=28 height=28 alt="oauth3 seal">${brandWord}</div>
${body}
<div class=halftone aria-hidden=true></div>
<footer><a href="./">Home</a><a href="login">Sign in</a><a href="privacy">Privacy</a><a href="terms">Terms</a><a href="${SOURCE}">Source</a></footer>
</body></html>`;
}

function baseOf(env: Record<string, string>): string {
  try { return env.PUBLIC_URL ? new URL(env.PUBLIC_URL).pathname : ""; } catch { return ""; }
}

export function homePage(env: Record<string, string> = {}): string {
  const owner = env.OWNER_NAME || env.OAUTH3_OWNER_NAME || "";
  const src = env.SOURCE_URL || SOURCE;
  // App name matches the OAuth consent-screen name (Google requires home page == consent name).
  const brandWord = owner ? `${esc(owner)}'s oauth<b>3</b> server` : "oauth<b>3</b>";
  const appName = owner ? `${esc(owner)}'s OAuth3 server` : "OAuth3";
  return shell("Home", `
<h1>Delegate access — without handing over your passwords or cookies.</h1>
<p class=lede>OAuth3 is a personal identity &amp; delegation service that runs inside a secure
enclave (TEE). Your site logins are sealed in the enclave; apps you approve get
<b>scoped, revocable</b> access to specific data — never your raw cookies.</p>
<div class=row>
  <a class=btn id=cta href="login">Sign in to this pod</a>
  <a class="btn ghost" href="${src}">Run your own ↗</a>
</div>
<div class=note><b>This is ${owner ? esc(owner) + "'s" : "a"} personal instance.</b> It's like a
federated homeserver — you're welcome to use it as your identity service, but you don't have to
take the operator's word for it: it runs in a TEE and the code is open — <a href="evidence">see the
evidence ↗</a>. Prefer your own? It's self-hostable — <a href="${src}">grab the code</a> and run your own.</div>
<h2>How it works</h2>
<ul>
  <li><b>Sign in</b> with a passkey, GitHub, Google, OpenKey, or your browser key — link several to one account.</li>
  <li><b>Sync a site</b> (via the extension): its cookies are stored <b>sealed</b> in the enclave, never in plaintext on a server.</li>
  <li><b>Approve an app</b>: it gets a scoped token to read just what you allowed — revoke it anytime from your dashboard.</li>
</ul>
<p class=muted>No raw cookies leave the enclave. The operator cannot read your sealed jar.</p>
<script>
 // #67: a signed-in visitor shouldn't linger on the landing. The localStorage session is
 // checked against api/me (not trusted) so a stale one keeps the sign-in CTA; a failed check
 // rejects loudly instead of guessing signed-in.
 (function(){
  var t=localStorage.getItem('oauth3_session');
  if(!t)return;
  fetch('api/me',{headers:{Authorization:'Bearer '+t}}).then(function(r){return r.json();}).then(function(me){
    if(!me.signedIn)return;
    var cta=document.getElementById('cta');
    cta.textContent='Go to your dashboard';cta.href='dashboard';
    var f=document.querySelector('footer a[href="login"]');
    f.textContent='Dashboard';f.href='dashboard';
  });
 })();
</script>`, brandWord, appName, baseOf(env));
}

export function privacyPage(env: Record<string, string> = {}): string {
  const contact = env.OWNER_EMAIL || env.OAUTH3_OWNER_EMAIL || "the operator";
  return shell("Privacy", `
<h1>Privacy policy</h1>
<p class=muted>This is a personal, self-hostable instance. Plain language, no dark patterns.</p>
<h2>What is stored</h2>
<ul>
  <li><b>Your sign-in identity</b> — a stable id from your chosen method (passkey credential, GitHub/Google account id, did:key, or a random browser key). Not your password.</li>
  <li><b>Site cookies you choose to sync</b> — stored <b>encrypted (AES-GCM) and sealed inside the TEE</b>. They are used only to fetch data for apps you authorize. They are never stored in plaintext and the operator cannot read them.</li>
  <li><b>Scoped tokens &amp; an access log</b> — which apps you approved and what they read, so you can review and revoke.</li>
</ul>
<h2>How it is used</h2>
<ul>
  <li>Only to provide the scoped, revocable access <b>you</b> approve. Nothing is sold or shared for advertising.</li>
  <li>Data leaves the enclave only as the specific reads an app you approved performs against the site you connected.</li>
</ul>
<h2>Third parties</h2>
<ul>
  <li><b>Sign-in providers</b> (GitHub, Google) see only that you authenticated; their own privacy policies apply.</li>
  <li><b>Sites you connect</b> receive requests made with your cookies, as you would yourself.</li>
</ul>
<h2>Your control</h2>
<ul>
  <li>Revoke any app token and disconnect (shred) any synced site at any time from your dashboard.</li>
  <li>Deleting a jar removes the sealed cookies from the enclave.</li>
</ul>
<h2>Contact</h2>
<p>Questions: ${esc(contact)}. Or run your own instance — the code is <a href="${env.SOURCE_URL || SOURCE}">open source</a>.</p>`, undefined, undefined, baseOf(env));
}

export function termsPage(env: Record<string, string> = {}): string {
  return shell("Terms", `
<h1>Terms of service</h1>
<p class=muted>A personal, experimental instance — provided as-is.</p>
<ul>
  <li>This service is provided <b>"as is", without warranty</b>. It's a personal/experimental deployment, not a commercial product.</li>
  <li>You are responsible for the accounts and cookies you choose to sync, and for the apps you approve.</li>
  <li>Only connect accounts you control. Don't use the service to access data you're not entitled to.</li>
  <li>The operator may revoke access or take the instance down at any time.</li>
  <li>OAuth3 is not affiliated with the sites or identity providers you connect through it.</li>
  <li>Prefer different terms? It's self-hostable — <a href="${env.SOURCE_URL || SOURCE}">run your own</a>.</li>
</ul>`, undefined, undefined, baseOf(env));
}

// "Don't trust the operator" only works if you can check the evidence. Honest about the
// current state (the pod is dev mode, not yet attested — see #32).
export function evidencePage(env: Record<string, string> = {}): string {
  const src = env.SOURCE_URL || SOURCE;
  return shell("Evidence", `
<h1>Evidence — don't trust, verify</h1>
<p class=lede>You shouldn't have to trust the operator personally. Running in a TEE means you can verify the <b>code</b> instead. Here's what to check:</p>
<h2>1. The source</h2>
<p>Read exactly what this instance runs: <a href="${src}">${esc(src)}</a>.</p>
<h2>2. The enclave</h2>
<p>It runs as a dstack app on Phala inside a Trusted Execution Environment. The machine-checkable evidence bundle — the source binding + the platform quote — is at <a href="/_api/verification/oauth3">/_api/verification/oauth3</a>.</p>
<h2>3. Attested mode</h2>
<p>Status: <b id=att-status>checking the live verifier…</b><span id=att-detail></span></p>
<p class=muted>Don't want to rely on anyone's instance? <a href="${src}">Run your own.</a></p>
<script>
fetch('/_api/verification/oauth3').then(function(r){
  var s=document.getElementById('att-status'), d=document.getElementById('att-detail');
  if(r.ok){ s.textContent='attested'; s.style.color='#059669';
    r.json().then(function(b){ var src=(b.app&&b.app.source)||b.source||{}; var c=src.commit_sha||src.commit||'';
      d.innerHTML=' — the running code is measured and pinned; a relying party can confirm it matches the source above. <a href="/_api/verification/oauth3">Evidence bundle</a>'+(c?(' (commit <code>'+String(c).slice(0,10)+'</code>)'):'')+'.'; });
  } else { s.textContent='dev'; d.innerHTML=' — the measurement isn\\'t pinned yet, so the trust story is in-progress. The source and enclave above are still inspectable. <a href="/_api/verification/oauth3">Verifier</a>.'; }
}).catch(function(){ document.getElementById('att-detail').innerHTML=' — could not reach the verifier; <a href="/_api/verification/oauth3">check it directly</a>.'; });
</script>`, undefined, undefined, baseOf(env));
}

function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}
